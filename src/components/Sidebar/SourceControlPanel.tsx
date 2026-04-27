import { useMemo, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  useGitFullStatus,
  stagePaths,
  unstagePaths,
  commitStaged,
  type GitStatusCode,
} from '../../lib/git';
import { useToast } from '../ui/Toast';
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

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

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
      } else {
        toast.error('Commit failed', res.error);
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

  return (
    <div className="scp">
      {/* v0.16.0 — commit composer pinned at the top. Disabled until
          there's something staged AND a non-empty message. */}
      <div className="scp__commit">
        <textarea
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
