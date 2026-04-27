import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { setPendingReveal } from '../../lib/reveal';
import './SearchInFiles.css';

interface Hit {
  path: string;
  line: number;
  text: string;
}

type GroupedHits = { path: string; rel: string; hits: Hit[] };

const DEBOUNCE_MS = 300;

export function SearchInFiles() {
  const { workspaceRoot, openFile } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [glob, setGlob] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Tracks the most-recent search request so a slower in-flight call
  // can't overwrite the most-recent results.
  const reqIdRef = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setCursor(0);
  }, []);

  // Ctrl/Cmd+Shift+F toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape' && open) close();
    };
    // Capture phase to beat Monaco's own Ctrl+F handler when focus is
    // inside the editor — VSCode does the same for its global search.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, close]);

  // Focus input when opening.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounce the query.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Run search on debounced query change.
  useEffect(() => {
    if (!open) return;
    if (!workspaceRoot) {
      setHits([]);
      setErrorMsg(null);
      return;
    }
    const q = debounced.trim();
    if (q.length < 2) {
      setHits([]);
      setErrorMsg(null);
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setErrorMsg(null);
    // Pattern: literal substring by default — escape regex metachars
    // unless the user explicitly enabled regex mode.
    const pattern = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    window.suxai.search
      .grep({
        pattern,
        cwd: workspaceRoot,
        max_results: 200,
        case_sensitive: caseSensitive,
        glob: glob.trim() || undefined,
      })
      .then((res) => {
        if (reqId !== reqIdRef.current) return;
        if (res.error) {
          setErrorMsg(res.error);
          setHits([]);
        } else {
          setHits(res.hits ?? []);
          setErrorMsg(null);
        }
      })
      .catch((err: unknown) => {
        if (reqId !== reqIdRef.current) return;
        setErrorMsg((err as Error).message ?? 'Search failed');
        setHits([]);
      })
      .finally(() => {
        if (reqId === reqIdRef.current) setLoading(false);
      });
  }, [open, debounced, workspaceRoot, caseSensitive, regex, glob]);

  // Reset cursor whenever the visible list changes.
  useEffect(() => {
    setCursor(0);
  }, [hits]);

  const grouped = useMemo<GroupedHits[]>(() => {
    if (!workspaceRoot) return [];
    const map = new Map<string, GroupedHits>();
    for (const h of hits) {
      const abs: string = h.path.startsWith('/') || /^[a-zA-Z]:/.test(h.path)
        ? h.path
        : workspaceRoot.replace(/[\\/]+$/, '') + '/' + h.path;
      const rel = abs.startsWith(workspaceRoot)
        ? abs.slice(workspaceRoot.length).replace(/^[\\/]+/, '')
        : abs;
      const existing = map.get(abs);
      if (existing) {
        existing.hits.push({ ...h, path: abs });
      } else {
        map.set(abs, { path: abs, rel, hits: [{ ...h, path: abs }] });
      }
    }
    return Array.from(map.values());
  }, [hits, workspaceRoot]);

  // Flatten back out for keyboard navigation. Each entry knows its
  // group + index-in-group so we can render headers inline.
  type FlatRow =
    | { kind: 'group'; rel: string; path: string; count: number; gIdx: number }
    | { kind: 'hit'; gIdx: number; hIdx: number; hit: Hit };
  const flat = useMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    grouped.forEach((g, gIdx) => {
      out.push({ kind: 'group', rel: g.rel, path: g.path, count: g.hits.length, gIdx });
      g.hits.forEach((hit, hIdx) => {
        out.push({ kind: 'hit', gIdx, hIdx, hit });
      });
    });
    return out;
  }, [grouped]);

  const hitRows = useMemo(() => flat.filter((r) => r.kind === 'hit'), [flat]) as Extract<
    FlatRow,
    { kind: 'hit' }
  >[];

  const pickHit = useCallback(
    async (hitIdx: number) => {
      const row = hitRows[hitIdx];
      if (!row) return;
      const fullPath = row.hit.path;
      const name = fullPath.split(/[\\/]/).pop() ?? fullPath;
      try {
        const file = await window.suxai.fs.readFile(fullPath);
        // v0.13.16 (audit #5): stamp the reveal AFTER readFile resolves
        // but BEFORE openFile fires the React state update. If we
        // stamped before readFile and the read failed, the pending
        // reveal would persist forever and apply to a future,
        // unrelated open of the same path.
        setPendingReveal(file.path, row.hit.line, 1);
        openFile({ path: file.path, name, content: file.content });
        close();
      } catch (err) {
        setErrorMsg(`Cannot open ${name}: ${(err as Error).message}`);
      }
    },
    [hitRows, openFile, close],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(0, hitRows.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void pickHit(cursor);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="sif__overlay" role="dialog" aria-modal="true" onClick={close}>
      <div className="sif glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="sif__bar">
          <input
            ref={inputRef}
            className="sif__input"
            placeholder={workspaceRoot ? 'Search in files…' : 'Open a folder first'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
            disabled={!workspaceRoot}
          />
          <div className="sif__toggles" role="group" aria-label="Search options">
            <button
              type="button"
              className={`sif__toggle ${caseSensitive ? 'sif__toggle--on' : ''}`}
              title="Match case (Aa)"
              onClick={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </button>
            <button
              type="button"
              className={`sif__toggle ${regex ? 'sif__toggle--on' : ''}`}
              title="Use regex (.*)"
              onClick={() => setRegex((v) => !v)}
            >
              .*
            </button>
          </div>
        </div>
        <div className="sif__bar sif__bar--filter">
          <input
            className="sif__filter"
            placeholder="Files to include (e.g. *.ts) — optional"
            value={glob}
            onChange={(e) => setGlob(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="sif__count">
            {loading ? '…' : hitRows.length > 0 ? `${hitRows.length} matches` : ''}
          </span>
        </div>
        <div className="sif__list">
          {!workspaceRoot ? (
            <div className="sif__empty">No workspace open — use File › Open folder.</div>
          ) : errorMsg ? (
            <div className="sif__empty sif__empty--error">{errorMsg}</div>
          ) : debounced.trim().length < 2 ? (
            <div className="sif__empty">Type at least 2 characters to search.</div>
          ) : loading ? (
            <div className="sif__empty">Searching…</div>
          ) : hitRows.length === 0 ? (
            <div className="sif__empty">No matches</div>
          ) : (
            flat.map((row, idx) => {
              if (row.kind === 'group') {
                return (
                  <div key={`g-${row.path}`} className="sif__group" title={row.path}>
                    <span className="sif__group-name">{row.rel || row.path}</span>
                    <span className="sif__group-count">{row.count}</span>
                  </div>
                );
              }
              const hitIdx = hitRows.findIndex((h) => h === row);
              const isActive = hitIdx === cursor;
              return (
                <button
                  key={`h-${idx}`}
                  type="button"
                  className={`sif__hit ${isActive ? 'sif__hit--active' : ''}`}
                  onMouseEnter={() => setCursor(hitIdx)}
                  onClick={() => pickHit(hitIdx)}
                >
                  <span className="sif__line">{row.hit.line}</span>
                  <span className="sif__text">{row.hit.text}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
