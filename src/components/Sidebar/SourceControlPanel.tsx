import { useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  useGitFullStatus,
  useGitBranchState,
  useGitStashes,
  stagePaths,
  unstagePaths,
  commitStaged,
  gitFetch,
  gitPull,
  gitPush,
  stashPush,
  stashPop,
  stashApply,
  stashDrop,
  relativeTime,
  type GitStatusCode,
} from '../../lib/git';
import { useToast } from '../ui/Toast';
import { openBranchPicker } from './BranchPicker';
import { openGitLog } from './GitLogModal';
import './SourceControlPanel.css';

/**
 * v0.15.6 — Source Control panel. v0.16.0 upgrade : adds the
 * canonical Staged / Changes / Untracked / Conflicts buckets driven
 * by the porcelain XY codes, per-file stage/unstage buttons,
 * "stage all" / "unstage all" master controls, and a commit
 * message input that pipes through `git commit -F -`.
 *
 * Reuses useGitFullStatus → same cache + IPC + invalidation as the
 * sidebar badges, so a stage from here refreshes the badges
 * elsewhere for free.
 *
 * Click a row → opens the file in the editor. Hover → reveals the
 * stage/unstage button on the right.
 */

interface PathEntry {
  path: string;
  /** Single-letter visual badge (M/A/D/U/R/C). */
  code: GitStatusCode;
}

type SectionId = 'staged' | 'conflicts' | 'changes' | 'untracked';
interface Section {
  id: SectionId;
  label: string;
  paths: PathEntry[];
  /** True when this section's items can be staged (changes/untracked). */
  canStage: boolean;
  /** True when this section's items can be unstaged (staged). */
  canUnstage: boolean;
}

const STATUS_TITLES: Record<GitStatusCode, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  U: 'Untracked',
  R: 'Renamed',
  C: 'Conflict',
};

function bestCode(x: string, y: string): GitStatusCode {
  if (x === '?' || y === '?') return 'U';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'C';
  const c = (y !== ' ' && y !== '' ? y : x !== ' ' && x !== '' ? x : 'M');
  if (c === 'M' || c === 'A' || c === 'D' || c === 'R') return c;
  return 'M';
}

export function SourceControlPanel() {
  const { workspaceRoot, openFile } = useWorkspace();
  const { detail, root: repoRoot } = useGitFullStatus(workspaceRoot);
  const toast = useToast();

  const branchState = useGitBranchState(workspaceRoot);
  const stashes = useGitStashes(workspaceRoot);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [syncBusy, setSyncBusy] = useState<'fetch' | 'pull' | 'push' | null>(null);
  const [stashBusy, setStashBusy] = useState(false);
  const commitInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Bucket every path by its XY codes :
  //   staged    : X != ' ' && X != '?' && not in conflict
  //   conflicts : X/Y indicate UU/AA/DD/etc
  //   changes   : Y != ' ' && Y != '?' && not in conflict (worktree dirty)
  //   untracked : ?? (only Y == '?')
  // A single file can appear in BOTH staged AND changes when it has a
  // staged change AND further unstaged worktree edits — that's the
  // canonical VSCode SC behaviour and matches what `git status` shows.
  const sections = useMemo<Section[]>(() => {
    const staged: PathEntry[] = [];
    const conflicts: PathEntry[] = [];
    const changes: PathEntry[] = [];
    const untracked: PathEntry[] = [];

    for (const [path, d] of Object.entries(detail)) {
      const x = d.x;
      const y = d.y;
      const isUntracked = x === '?' && y === '?';
      const isConflict =
        x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
      const hasStaged = !isUntracked && !isConflict && x !== ' ' && x !== '';
      const hasUnstaged = !isUntracked && !isConflict && y !== ' ' && y !== '';

      if (isConflict) conflicts.push({ path, code: 'C' });
      else if (isUntracked) untracked.push({ path, code: 'U' });
      else {
        if (hasStaged) staged.push({ path, code: bestCode(x, ' ') });
        if (hasUnstaged) changes.push({ path, code: bestCode(' ', y) });
      }
    }

    const byPath = (a: PathEntry, b: PathEntry) => a.path.localeCompare(b.path);
    staged.sort(byPath);
    conflicts.sort(byPath);
    changes.sort(byPath);
    untracked.sort(byPath);

    const all: Section[] = [
      { id: 'staged',    label: 'Staged Changes', paths: staged,    canStage: false, canUnstage: true  },
      { id: 'conflicts', label: 'Conflicts',      paths: conflicts, canStage: true,  canUnstage: false },
      { id: 'changes',   label: 'Changes',        paths: changes,   canStage: true,  canUnstage: false },
      { id: 'untracked', label: 'Untracked',      paths: untracked, canStage: true,  canUnstage: false },
    ];
    return all.filter((s) => s.paths.length > 0);
  }, [detail]);

  const totalDirty = sections.reduce((acc, s) => acc + s.paths.length, 0);
  const stagedSection = sections.find((s) => s.id === 'staged');
  const stagedCount = stagedSection?.paths.length ?? 0;

  const onPick = async (absPath: string) => {
    const name = absPath.split(/[\\/]/).pop() ?? absPath;
    try {
      const file = await window.suxai.fs.readFile(absPath);
      openFile({ path: file.path, name, content: file.content });
    } catch {
      // Deleted files can't be opened — silently swallow.
    }
  };

  const opCwd = repoRoot ?? workspaceRoot;

  const onStageOne = async (absPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!opCwd) return;
    const err = await stagePaths(opCwd, [absPath]);
    if (err) toast.error('Stage failed', err);
  };

  const onUnstageOne = async (absPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!opCwd) return;
    const err = await unstagePaths(opCwd, [absPath]);
    if (err) toast.error('Unstage failed', err);
  };

  const onStageSection = async (section: Section, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!opCwd || section.paths.length === 0) return;
    const err = await stagePaths(opCwd, section.paths.map((p) => p.path));
    if (err) toast.error('Stage all failed', err);
    else toast.info('Staged', `${section.paths.length} file${section.paths.length > 1 ? 's' : ''}`);
  };

  const onUnstageSection = async (section: Section, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!opCwd || section.paths.length === 0) return;
    const err = await unstagePaths(opCwd, section.paths.map((p) => p.path));
    if (err) toast.error('Unstage all failed', err);
    else toast.info('Unstaged', `${section.paths.length} file${section.paths.length > 1 ? 's' : ''}`);
  };

  const onCommit = async () => {
    const msg = commitMessage.trim();
    if (!msg) {
      toast.error('Commit message required', 'Type a summary above');
      return;
    }
    if (!opCwd) return;
    if (stagedCount === 0) {
      toast.error('Nothing to commit', 'Stage some changes first');
      return;
    }
    setCommitting(true);
    try {
      const res = await commitStaged(opCwd, msg);
      if (res.ok) {
        setCommitMessage('');
        toast.success(
          'Committed',
          res.sha ? `${res.sha.slice(0, 7)}${res.branch ? ` on ${res.branch}` : ''}` : msg.split('\n', 1)[0],
        );
        // v0.16.15 polish — refocus the composer so the next commit
        // can be typed without grabbing the mouse. Defer one tick so
        // the disabled→enabled transition has settled.
        setTimeout(() => commitInputRef.current?.focus(), 0);
      } else {
        toast.error('Commit failed', res.error);
        // Don't clear the message on failure — let the user fix it
        // and retry. Refocus to bring the cursor back to where they
        // left off.
        commitInputRef.current?.focus();
      }
    } finally {
      setCommitting(false);
    }
  };

  const relPath = (abs: string): string => {
    const base = repoRoot ?? workspaceRoot;
    if (!base) return abs;
    const root = base.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    const norm = abs.replace(/\\/g, '/');
    if (norm.startsWith(root + '/')) return norm.slice(root.length + 1);
    if (norm === root) return abs.split(/[\\/]/).pop() ?? abs;
    return norm;
  };

  if (!workspaceRoot) {
    return (
      <div className="scp__empty">
        <p>No folder opened</p>
        <p className="scp__hint">Open a folder to see git changes here.</p>
      </div>
    );
  }

  const onStashAll = async () => {
    if (!opCwd || stashBusy) return;
    if (totalDirty === 0) {
      toast.info('Nothing to stash', 'Working tree is clean.');
      return;
    }
    setStashBusy(true);
    try {
      const err = await stashPush(opCwd, undefined, true);
      if (err) toast.error('Stash failed', err);
      else toast.success('Stashed', `${totalDirty} file${totalDirty > 1 ? 's' : ''} saved.`);
    } finally {
      setStashBusy(false);
    }
  };

  const onStashAction = async (
    index: number,
    op: 'pop' | 'apply' | 'drop',
    label: string,
  ) => {
    if (!opCwd || stashBusy) return;
    setStashBusy(true);
    try {
      const fn = op === 'pop' ? stashPop : op === 'apply' ? stashApply : stashDrop;
      const err = await fn(opCwd, index);
      if (err) toast.error(`${op} failed`, err);
      else toast.success(`${op[0].toUpperCase()}${op.slice(1)}ped`, label);
    } finally {
      setStashBusy(false);
    }
  };

  const onSync = async (op: 'fetch' | 'pull' | 'push') => {
    if (!opCwd || syncBusy) return;
    setSyncBusy(op);
    try {
      const fn = op === 'fetch' ? gitFetch : op === 'pull' ? gitPull : gitPush;
      const err = await fn(opCwd);
      if (err) {
        toast.error(`${op[0].toUpperCase()}${op.slice(1)} failed`, err);
      } else {
        toast.success(`${op[0].toUpperCase()}${op.slice(1)} done`,
          op === 'fetch' ? 'Remote refs updated' :
          op === 'pull'  ? 'Pulled fast-forward' :
          'Pushed to remote');
      }
    } finally {
      setSyncBusy(null);
    }
  };

  return (
    <div className="scp">
      {/* v0.16.16 — sync row : branch indicator + fetch/pull/push.
          The branch button opens the BranchPicker modal ; sync buttons
          show ahead/behind counts as superscript when relevant. */}
      <div className="scp__sync">
        <button
          type="button"
          className="scp__branch"
          onClick={() => openBranchPicker()}
          disabled={!opCwd || !branchState.branch}
          title={branchState.branch
            ? `Switch branch (current: ${branchState.branch})`
            : 'Not a git repo'}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="6" cy="19" r="2" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="18" cy="12" r="2" stroke="currentColor" strokeWidth="1.7" />
            <path d="M6 7v10 M8 19h2a4 4 0 0 0 4-4v-3 M8 5h2a4 4 0 0 1 4 4v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <span className="scp__branch-name">{branchState.branch ?? '—'}</span>
        </button>
        <div className="scp__sync-actions">
          <button
            type="button"
            className="scp__sync-btn"
            onClick={() => openGitLog()}
            disabled={!opCwd}
            title="Show commit history"
            aria-label="Show history"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={`scp__sync-btn ${stashBusy ? 'scp__sync-btn--busy' : ''}`}
            onClick={() => void onStashAll()}
            disabled={!opCwd || stashBusy || totalDirty === 0}
            title={totalDirty === 0
              ? 'Nothing to stash'
              : `Stash all ${totalDirty} change${totalDirty > 1 ? 's' : ''}`}
            aria-label="Stash all changes"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M3 8h18v3H3z M5 11v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9 M9 14h6" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className={`scp__sync-btn ${syncBusy === 'fetch' ? 'scp__sync-btn--busy' : ''}`}
            onClick={() => void onSync('fetch')}
            disabled={!opCwd || syncBusy !== null}
            title="git fetch --prune"
            aria-label="Fetch"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className={`scp__sync-btn ${syncBusy === 'pull' ? 'scp__sync-btn--busy' : ''}`}
            onClick={() => void onSync('pull')}
            disabled={!opCwd || syncBusy !== null || !branchState.hasUpstream}
            title={branchState.hasUpstream
              ? `git pull --ff-only${branchState.behind > 0 ? ` (${branchState.behind} behind)` : ''}`
              : 'No upstream configured'}
            aria-label="Pull"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 4v14M5 13l7 7 7-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {branchState.behind > 0 && (
              <span className="scp__sync-count">{branchState.behind}</span>
            )}
          </button>
          <button
            type="button"
            className={`scp__sync-btn ${syncBusy === 'push' ? 'scp__sync-btn--busy' : ''}`}
            onClick={() => void onSync('push')}
            disabled={!opCwd || syncBusy !== null}
            title={branchState.ahead > 0
              ? `git push (${branchState.ahead} ahead)`
              : 'git push (nothing to push)'}
            aria-label="Push"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 20V6M5 11l7-7 7 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {branchState.ahead > 0 && (
              <span className="scp__sync-count">{branchState.ahead}</span>
            )}
          </button>
        </div>
      </div>
      {/* v0.16.0 — commit composer pinned at the top. Disabled until
          there's something staged AND a non-empty message. */}
      <div className="scp__commit">
        <textarea
          ref={commitInputRef}
          className="scp__commit-input"
          placeholder={
            stagedCount > 0
              ? `Message (Ctrl+Enter to commit ${stagedCount} file${stagedCount > 1 ? 's' : ''})`
              : 'Stage some changes first'
          }
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void onCommit();
            }
          }}
          rows={2}
          spellCheck={false}
          disabled={committing}
        />
        <button
          type="button"
          className="scp__commit-btn"
          onClick={() => void onCommit()}
          disabled={
            committing || stagedCount === 0 || commitMessage.trim().length === 0
          }
          title={
            stagedCount === 0
              ? 'Stage some changes first'
              : `Commit ${stagedCount} staged file${stagedCount > 1 ? 's' : ''}`
          }
        >
          {committing ? 'Committing…' : `Commit${stagedCount > 0 ? ` (${stagedCount})` : ''}`}
        </button>
      </div>

      {/* v2.3 (C3) — Stashes section. Hidden when empty so we don't
          clutter the panel for users who never stash. Apply / Pop /
          Drop actions per row. */}
      {stashes.length > 0 && (
        <div className="scp__section scp__section--stash">
          <div className="scp__section-head scp__section-head--stash">
            <button
              type="button"
              className="scp__section-toggle"
              onClick={() => setCollapsed((c) => ({ ...c, stashes: !c.stashes }))}
              aria-expanded={!collapsed.stashes}
            >
              <span className={`scp__chev ${collapsed.stashes ? 'scp__chev--collapsed' : ''}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
                </svg>
              </span>
              <span className="scp__section-label">Stashes</span>
              <span className="scp__section-count">{stashes.length}</span>
            </button>
          </div>
          {!collapsed.stashes && (
            <ul className="scp__list">
              {stashes.map((s) => (
                <li key={s.ref}>
                  <div className="scp__row scp__row--stash" title={s.subject}>
                    <span className="scp__row-name">{s.subject}</span>
                    <span className="scp__row-dir">{relativeTime(s.dateIso)}</span>
                    <span className="scp__row-actions">
                      <button
                        type="button"
                        className="scp__row-act"
                        onClick={() => void onStashAction(s.index, 'pop', s.subject)}
                        disabled={stashBusy}
                        title="Pop (apply + drop)"
                        aria-label="Pop stash"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="scp__row-act"
                        onClick={() => void onStashAction(s.index, 'apply', s.subject)}
                        disabled={stashBusy}
                        title="Apply (keep stash)"
                        aria-label="Apply stash"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M5 12l4 4 10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="scp__row-act scp__row-act--unstage"
                        onClick={() => void onStashAction(s.index, 'drop', s.subject)}
                        disabled={stashBusy}
                        title="Drop (discard)"
                        aria-label="Drop stash"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </span>
                    <span className="scp__row-badge scp__row-badge--stash">
                      {s.index}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {totalDirty === 0 ? (
        <div className="scp__empty">
          <p>Working tree clean</p>
          <p className="scp__hint">No tracked or untracked changes detected.</p>
        </div>
      ) : (
        sections.map((section) => {
          const isCollapsed = collapsed[section.id];
          return (
            <div key={section.id} className="scp__section">
              <div className={`scp__section-head scp__section-head--${section.id}`}>
                <button
                  type="button"
                  className="scp__section-toggle"
                  onClick={() => setCollapsed((c) => ({ ...c, [section.id]: !isCollapsed }))}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`scp__chev ${isCollapsed ? 'scp__chev--collapsed' : ''}`}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                      <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
                    </svg>
                  </span>
                  <span className="scp__section-label">{section.label}</span>
                  <span className="scp__section-count">{section.paths.length}</span>
                </button>
                <div className="scp__section-actions">
                  {section.canStage && (
                    <button
                      type="button"
                      className="scp__section-act scp__section-act--stage"
                      onClick={(e) => onStageSection(section, e)}
                      title={`Stage all ${section.paths.length} ${section.label.toLowerCase()}`}
                      aria-label={`Stage all in ${section.label}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                  {section.canUnstage && (
                    <button
                      type="button"
                      className="scp__section-act scp__section-act--unstage"
                      onClick={(e) => onUnstageSection(section, e)}
                      title={`Unstage all ${section.paths.length} staged file${section.paths.length > 1 ? 's' : ''}`}
                      aria-label={`Unstage all in ${section.label}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              {!isCollapsed && (
                <ul className="scp__list">
                  {section.paths.map(({ path, code }) => {
                    const rel = relPath(path);
                    const parts = rel.split('/');
                    const fileName = parts.pop() ?? rel;
                    const dir = parts.join('/');
                    return (
                      <li key={`${section.id}:${path}`}>
                        <button
                          type="button"
                          className="scp__row"
                          onClick={() => onPick(path)}
                          title={path}
                        >
                          <span className="scp__row-name">{fileName}</span>
                          {dir && <span className="scp__row-dir">{dir}</span>}
                          <span className="scp__row-actions">
                            {section.canStage && (
                              <button
                                type="button"
                                className="scp__row-act scp__row-act--stage"
                                onClick={(e) => onStageOne(path, e)}
                                title="Stage this file"
                                aria-label={`Stage ${fileName}`}
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              </button>
                            )}
                            {section.canUnstage && (
                              <button
                                type="button"
                                className="scp__row-act scp__row-act--unstage"
                                onClick={(e) => onUnstageOne(path, e)}
                                title="Unstage this file"
                                aria-label={`Unstage ${fileName}`}
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                                  <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              </button>
                            )}
                          </span>
                          <span
                            className={`scp__row-badge scp__row-badge--${code}`}
                            aria-label={STATUS_TITLES[code]}
                          >
                            {code}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
