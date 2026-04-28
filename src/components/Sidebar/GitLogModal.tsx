import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getGitLog, relativeTime, type GitCommit } from '../../lib/git';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import './GitLogModal.css';

/**
 * v2.3 (C2) — Git log viewer.
 *
 * Read-only modal listing the N latest commits on the current branch
 * (default 100). Fuzzy filter by subject + author + short-sha. Click
 * a commit to expand its body in-place. Open via the
 * `suxai:git-log-open` CustomEvent (Command Palette + Source Control
 * header button both fire it).
 */
const GIT_LOG_OPEN_EVENT = 'suxai:git-log-open';

export function openGitLog(): void {
  window.dispatchEvent(new CustomEvent(GIT_LOG_OPEN_EVENT));
}

const LIMIT = 100;

export function GitLogHost() {
  const { workspaceRoot } = useWorkspace();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(GIT_LOG_OPEN_EVENT, handler);
    return () => window.removeEventListener(GIT_LOG_OPEN_EVENT, handler);
  }, []);
  return <GitLogModal cwd={workspaceRoot} open={open} onClose={() => setOpen(false)} />;
}

interface Props {
  cwd: string | null;
  open: boolean;
  onClose: () => void;
}

function fuzzyScore(haystack: string, query: string): number | null {
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let i = 0; i < h.length && qi < q.length; i++) {
    if (h[i] === q[qi]) {
      score += 10 - (i - (lastIdx + 1));
      lastIdx = i;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export function GitLogModal({ cwd, open, onClose }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Refetch on every open so the log reflects current HEAD without
  // a stale cache hanging around between sessions.
  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    setLoading(true);
    setExpandedSha(null);
    setQuery('');
    void getGitLog(cwd, LIMIT).then((list) => {
      if (cancelled) return;
      setCommits(list);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, cwd]);

  // Focus the search field on open.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  const filtered = useMemo<GitCommit[]>(() => {
    const q = query.trim();
    if (!q) return commits;
    return commits
      .map((c) => {
        const target = `${c.subject} ${c.author} ${c.shortSha}`;
        const s = fuzzyScore(target, q);
        return s !== null ? { c, s } : null;
      })
      .filter((x): x is { c: GitCommit; s: number } => x !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commits, query]);

  if (!open) return null;

  return createPortal(
    <div className="glog__overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="glog glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="glog__head">
          <span className="glog__head-icon" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="6" cy="18" r="2" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="18" cy="6" r="2" stroke="currentColor" strokeWidth="1.6" />
              <path d="M6 8v8 M8 6h6a4 4 0 0 1 4 4v0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="glog__input"
            placeholder={`Filter ${commits.length} commits by subject, author, sha…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="glog__count">{filtered.length}</span>
        </div>
        <div className="glog__list">
          {!cwd ? (
            <div className="glog__empty">No workspace open.</div>
          ) : loading ? (
            <div className="glog__empty">Loading commits…</div>
          ) : commits.length === 0 ? (
            <div className="glog__empty">No commits found (or not a git repo).</div>
          ) : filtered.length === 0 ? (
            <div className="glog__empty">No commit matches <code>{query.trim()}</code>.</div>
          ) : (
            filtered.map((c) => {
              const expanded = expandedSha === c.sha;
              return (
                <button
                  key={c.sha}
                  type="button"
                  className={`glog__item ${expanded ? 'glog__item--expanded' : ''}`}
                  onClick={() => setExpandedSha(expanded ? null : c.sha)}
                  title={c.body || c.subject}
                >
                  <span className="glog__sha">{c.shortSha}</span>
                  <span className="glog__subject">{c.subject}</span>
                  <span className="glog__author">{c.author}</span>
                  <span className="glog__age">{relativeTime(c.dateIso)}</span>
                  {expanded && c.body && (
                    <pre className="glog__body">{c.body}</pre>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="glog__foot">
          Showing the latest {LIMIT} commits on the current branch.
          {' '}
          <kbd>Esc</kbd> close · click a row to expand body.
        </div>
      </div>
    </div>,
    document.body,
  );
}
