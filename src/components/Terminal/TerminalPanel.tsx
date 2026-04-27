import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';

interface Props {
  open: boolean;
  onToggle: () => void;
  onHeightChange?: (h: number) => void;
}

const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;

/**
 * Integrated terminal panel at the bottom of the IDE.
 *
 * One xterm.js instance, one shell session kept alive for the whole
 * panel lifetime. Toggle with Ctrl+` (handled at IDELayout level).
 *
 * We don't use node-pty (avoids a native build step) — instead the main
 * process pipes a plain child_process. That means no TUI features
 * (vim, htop), but it works cleanly for the primary use case:
 * `npm run build`, `pytest`, `git status`, etc.
 */
export function TerminalPanel({ open, onToggle, onHeightChange }: Props) {
  const { workspaceRoot } = useWorkspace();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // v0.16.1 — addons WebGL/Search/WebLinks. Refs pour pouvoir
  // recréer l'addon WebGL si on perd le contexte (GPU crash) sans
  // toucher au reste du terminal.
  const webglRef = useRef<WebglAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const webLinksRef = useRef<WebLinksAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const spawningRef = useRef(false);
  const offDataRef = useRef<(() => void) | null>(null);
  const offExitRef = useRef<(() => void) | null>(null);
  const termOnDataRef = useRef<{ dispose(): void } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);

  // Boot the xterm instance once.
  useEffect(() => {
    if (termRef.current) return;
    const term = new XTerm({
      fontFamily: 'JetBrains Mono, Fira Code, Menlo, monospace',
      fontSize: 12.5,
      theme: {
        background: '#0b0f17',
        foreground: '#e8ecf4',
        cursor: '#7d82f8',
        cursorAccent: '#0b0f17',
        selectionBackground: '#3b4b75aa',
        black: '#1a2338',
        red: '#ff8e8e',
        green: '#86efac',
        yellow: '#fbbf24',
        blue: '#7d82f8',
        magenta: '#f472b6',
        cyan: '#7dd3fc',
        white: '#e8ecf4',
        brightBlack: '#455065',
        brightRed: '#ff8e8e',
        brightGreen: '#86efac',
        brightYellow: '#fbbf24',
        brightBlue: '#7d82f8',
        brightMagenta: '#f472b6',
        brightCyan: '#7dd3fc',
        brightWhite: '#ffffff',
      },
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // v0.16.1 — Search + WebLinks chargés à la création (zero-cost
    // tant qu'on ne s'en sert pas). WebLinks transforme http(s):// en
    // liens cliquables (callback shell.openExternal côté main).
    const search = new SearchAddon();
    const webLinks = new WebLinksAddon((event, uri) => {
      // Ne pas suivre sur Ctrl+Click vide (xterm fire spuriously) ;
      // exiger une vraie intention via metaKey/ctrlKey + bouton 1.
      if (event.button !== 0) return;
      try { window.suxai.fs.revealInFolder?.(uri); } catch { /* */ }
      // Pour les URLs externes, openExternal — le revealInFolder
      // fallback ci-dessus ne s'applique qu'aux paths fichiers ; les
      // vrais URLs http partent via shell.
      if (/^https?:\/\//i.test(uri)) {
        try { void window.open(uri, '_blank', 'noopener'); } catch { /* */ }
      }
    });
    term.loadAddon(search);
    term.loadAddon(webLinks);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    webLinksRef.current = webLinks;
    return () => {
      try { webglRef.current?.dispose(); } catch { /* */ }
      try { search.dispose(); } catch { /* */ }
      try { webLinks.dispose(); } catch { /* */ }
      term.dispose();
      webglRef.current = null;
      searchRef.current = null;
      webLinksRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Mount into the DOM + spawn shell when the panel opens the first time.
  useEffect(() => {
    if (!open) return;
    const term = termRef.current;
    const host = hostRef.current;
    if (!term || !host) return;
    if (term.element && term.element.parentElement === host) {
      fitRef.current?.fit();
      return;
    }
    term.open(host);
    fitRef.current?.fit();
    term.focus();

    // v0.16.1 — WebGL renderer activé après term.open(). Améliore
    // drastiquement le throughput (~20× vs canvas) sur logs verbeux
    // (npm install, build TypeScript, watch mode). Si le contexte
    // WebGL est perdu (driver crash, GPU reset), on dispose et on
    // retombe silencieusement sur le renderer canvas par défaut —
    // pas de re-essai en boucle qui consommerait CPU.
    if (!webglRef.current) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try { webgl.dispose(); } catch { /* */ }
          webglRef.current = null;
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // WebGL pas dispo (machine headless, GPU bloqué, vGPU bridé) —
        // on continue avec le renderer canvas par défaut.
      }
    }

    (async () => {
      if (sessionIdRef.current || spawningRef.current) return; // already spawned / in flight
      spawningRef.current = true;
      try {
        const { id, shell } = await window.suxai.terminal.spawn(workspaceRoot ?? undefined);
        sessionIdRef.current = id;
        term.writeln(`\x1b[2m[suxai] ${shell} — ${workspaceRoot ?? 'default cwd'}\x1b[0m`);
        offDataRef.current?.();
        offExitRef.current?.();
        offDataRef.current = window.suxai.terminal.onData((p) => {
          if (p.id === id) term.write(p.chunk);
        });
        offExitRef.current = window.suxai.terminal.onExit((p) => {
          if (p.id === id) {
            term.writeln(`\r\n\x1b[33m[exit ${p.code ?? 0}]\x1b[0m`);
            sessionIdRef.current = null;
          }
        });
        if (!termOnDataRef.current) {
          termOnDataRef.current = term.onData((data) => {
            if (sessionIdRef.current)
              void window.suxai.terminal.write(sessionIdRef.current, data);
          });
        }
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[spawn failed] ${(err as Error).message}\x1b[0m`);
      } finally {
        spawningRef.current = false;
      }
    })();

    return () => {
      // The terminal + session outlive the open/close cycle. We only
      // detach listeners when the panel itself unmounts.
    };
  }, [open, workspaceRoot]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      offDataRef.current?.();
      offExitRef.current?.();
      offDataRef.current = null;
      offExitRef.current = null;
      termOnDataRef.current?.dispose();
      termOnDataRef.current = null;
      if (sessionIdRef.current) {
        void window.suxai.terminal.kill(sessionIdRef.current);
        sessionIdRef.current = null;
      }
    };
  }, []);

  // Refit when size changes.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => fitRef.current?.fit(), 60);
    return () => clearTimeout(t);
  }, [open, height]);

  // Global resize observer.
  useEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try { fitRef.current?.fit(); }
        catch { /* term may be disposed mid-resize */ }
      });
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [open]);

  useEffect(() => {
    onHeightChange?.(open ? height : 0);
  }, [open, height, onHeightChange]);

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.max(
        MIN_HEIGHT,
        Math.min(MAX_HEIGHT, window.innerHeight - e.clientY),
      );
      setHeight(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  // v0.16.1 — Ctrl+F dans le terminal ouvre un mini panneau de
  // recherche. Listener limité au terminal lui-même (pas window) pour
  // ne pas voler Ctrl+F à Monaco quand le focus est dans l'éditeur.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 30);
      }
    };
    host.addEventListener('keydown', handler);
    return () => host.removeEventListener('keydown', handler);
  }, [open]);

  const onSearchNext = () => {
    const q = searchQuery.trim();
    if (!q || !searchRef.current) return;
    searchRef.current.findNext(q, { caseSensitive: false, wholeWord: false });
  };
  const onSearchPrev = () => {
    const q = searchQuery.trim();
    if (!q || !searchRef.current) return;
    searchRef.current.findPrevious(q, { caseSensitive: false, wholeWord: false });
  };
  const onSearchClose = () => {
    setSearchOpen(false);
    setSearchQuery('');
    try { searchRef.current?.clearDecorations(); } catch { /* */ }
    termRef.current?.focus();
  };

  if (!open) return null;

  return (
    <div className="termpanel" style={{ height }}>
      <div
        className="termpanel__grip"
        onMouseDown={onDragStart}
        aria-label="Resize terminal"
      />
      <div className="termpanel__head">
        <div className="termpanel__title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 17l6-6-6-6M12 19h8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Terminal
        </div>
        <div className="termpanel__actions">
          <button
            type="button"
            className="termpanel__btn"
            onClick={() => {
              setSearchOpen((v) => {
                const next = !v;
                if (next) setTimeout(() => searchInputRef.current?.focus(), 30);
                else onSearchClose();
                return next;
              });
            }}
            title="Find in terminal (Ctrl+F)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="termpanel__btn"
            onClick={() => termRef.current?.clear()}
            title="Clear"
          >
            ⌧
          </button>
          <button
            type="button"
            className="termpanel__btn termpanel__btn--close"
            onClick={onToggle}
            title="Hide terminal (Ctrl+`)"
          >
            ×
          </button>
        </div>
      </div>
      {searchOpen && (
        <div className="termpanel__search">
          <input
            ref={searchInputRef}
            className="termpanel__search-input"
            placeholder="Find in terminal…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) onSearchPrev();
                else onSearchNext();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onSearchClose();
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="termpanel__search-btn"
            onClick={onSearchPrev}
            title="Previous (Shift+Enter)"
            aria-label="Previous match"
          >
            ↑
          </button>
          <button
            type="button"
            className="termpanel__search-btn"
            onClick={onSearchNext}
            title="Next (Enter)"
            aria-label="Next match"
          >
            ↓
          </button>
          <button
            type="button"
            className="termpanel__search-btn termpanel__search-btn--close"
            onClick={onSearchClose}
            title="Close (Esc)"
            aria-label="Close search"
          >
            ×
          </button>
        </div>
      )}
      <div className="termpanel__host" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  );
}
