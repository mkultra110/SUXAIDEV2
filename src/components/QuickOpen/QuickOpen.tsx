import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useRecent, removeRecentIfMissing, type RecentFile } from '../../lib/recent';
import './QuickOpen.css';

interface WalkedFile {
  name: string;
  path: string;
  rel: string;
}

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'release',
  '.next',
  '.cache',
  '.vscode',
  '.idea',
  'coverage',
  'build',
]);

async function walkWorkspace(root: string, maxFiles = 5000): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await window.suxai.fs.readDir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORED.has(e.name)) continue;
      if (e.isDirectory) {
        stack.push(e.path);
      } else {
        const rel = e.path.startsWith(root)
          ? e.path.slice(root.length).replace(/^[\\/]+/, '')
          : e.path;
        out.push({ name: e.name, path: e.path, rel });
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

function fuzzyScore(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] === q[qi]) {
      // Bonus for matching at the start of a path segment.
      const atBoundary = i === 0 || l[i - 1] === '/' || l[i - 1] === '\\' || l[i - 1] === '.';
      score += atBoundary ? 20 : 10 - (i - (lastIdx + 1));
      lastIdx = i;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

export function QuickOpen() {
  const { workspaceRoot, openFile } = useWorkspace();
  const recent = useRecent();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<WalkedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
  }, []);

  // Ctrl/Cmd+P toggle (not shift).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape' && open) close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, close]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Index files when opened (cheap enough to redo; invalidated by workspace change).
  useEffect(() => {
    if (!open || !workspaceRoot) return;
    let cancelled = false;
    setLoading(true);
    walkWorkspace(workspaceRoot)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceRoot]);

  // v0.13.15 — when the query is empty we show the global Recent list
  // (VSCode behaviour: no walked files until the user starts typing).
  // With a non-empty query we fuzzy-filter the workspace walk.
  type Item =
    | { kind: 'recent'; recent: RecentFile }
    | { kind: 'file'; file: WalkedFile };

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    if (!q) {
      // Recent only — and skip recent entries that don't belong to
      // the current workspace if one is open, so cross-project leaks
      // don't pollute the picker.
      const eligible = workspaceRoot
        ? recent.filter((r) => !r.workspace || r.workspace === workspaceRoot)
        : recent;
      return eligible.slice(0, 12).map((r) => ({ kind: 'recent' as const, recent: r }));
    }
    return files
      .map((f) => {
        const s = fuzzyScore(f.rel, q);
        return s !== null ? { kind: 'file' as const, file: f, s } : null;
      })
      .filter(
        (x): x is { kind: 'file'; file: WalkedFile; s: number } => x !== null,
      )
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map(({ file }) => ({ kind: 'file' as const, file }));
  }, [query, files, recent, workspaceRoot]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  const pick = useCallback(
    async (i: number) => {
      const item = items[i];
      if (!item) return;
      close();
      const target =
        item.kind === 'recent'
          ? { path: item.recent.path, name: item.recent.name }
          : { path: item.file.path, name: item.file.name };
      try {
        const content = await window.suxai.fs.readFile(target.path);
        openFile({ path: content.path, name: target.name, content: content.content });
      } catch (err) {
        // v0.13.16 (audit #10): only drop the recent entry when the
        // file is genuinely gone — a transient permission error
        // shouldn't cost the user their recent-list entry.
        if (item.kind === 'recent') removeRecentIfMissing(item.recent.path, err);
        console.error('Failed to open file:', err);
      }
    },
    [items, close, openFile],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(0, items.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(cursor);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="qo__overlay" role="dialog" aria-modal="true" onClick={close}>
      <div className="qo glass-strong" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qo__input"
          placeholder={workspaceRoot ? 'Search files by name…' : 'Open a folder first'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
          disabled={!workspaceRoot}
        />
        <div className="qo__list">
          {!workspaceRoot && items.length === 0 ? (
            <div className="qo__empty">No workspace open — use File › Open folder (Ctrl+Shift+P).</div>
          ) : query.trim() && loading ? (
            <div className="qo__empty">Indexing workspace…</div>
          ) : items.length === 0 ? (
            <div className="qo__empty">
              {query.trim() ? 'No matching files' : 'No recent files yet — start typing to search.'}
            </div>
          ) : (
            <>
              {!query.trim() && items.length > 0 && (
                <div className="qo__group">Recent</div>
              )}
              {items.map((item, i) => {
                const isRecent = item.kind === 'recent';
                const path = isRecent ? item.recent.path : item.file.path;
                const name = isRecent ? item.recent.name : item.file.name;
                // For Recent: show the relative-to-workspace path if
                // possible, otherwise the parent dir absolute. For
                // walked files: their `rel` is workspace-relative.
                const dirHint = (() => {
                  if (isRecent) {
                    if (workspaceRoot && path.startsWith(workspaceRoot)) {
                      const rel = path.slice(workspaceRoot.length).replace(/^[\\/]+/, '');
                      const parts = rel.split(/[\\/]/);
                      parts.pop();
                      return parts.join('/');
                    }
                    const parts = path.split(/[\\/]/);
                    parts.pop();
                    return parts.join('/');
                  }
                  const parts = item.file.rel.split(/[\\/]/);
                  parts.pop();
                  return parts.join('/');
                })();
                return (
                  <button
                    key={`${item.kind}-${path}`}
                    type="button"
                    className={`qo__item ${i === cursor ? 'qo__item--active' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => pick(i)}
                  >
                    <span className="qo__name">{name}</span>
                    {dirHint && <span className="qo__dir">{dirHint}</span>}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
