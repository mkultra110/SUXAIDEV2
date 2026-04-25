import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
  const sessionIdRef = useRef<string | null>(null);
  const offDataRef = useRef<(() => void) | null>(null);
  const offExitRef = useRef<(() => void) | null>(null);
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
    termRef.current = term;
    fitRef.current = fit;
    return () => {
      term.dispose();
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

    (async () => {
      if (sessionIdRef.current) return; // already spawned
      try {
        const { id, shell } = await window.suxai.terminal.spawn(workspaceRoot ?? undefined);
        sessionIdRef.current = id;
        term.writeln(`\x1b[2m[suxai] ${shell} — ${workspaceRoot ?? 'default cwd'}\x1b[0m`);
        offDataRef.current = window.suxai.terminal.onData((p) => {
          if (p.id === id) term.write(p.chunk);
        });
        offExitRef.current = window.suxai.terminal.onExit((p) => {
          if (p.id === id) {
            term.writeln(`\r\n\x1b[33m[exit ${p.code ?? 0}]\x1b[0m`);
            sessionIdRef.current = null;
          }
        });
        term.onData((data) => {
          if (sessionIdRef.current)
            void window.suxai.terminal.write(sessionIdRef.current, data);
        });
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[spawn failed] ${(err as Error).message}\x1b[0m`);
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
      if (sessionIdRef.current) {
        void window.suxai.terminal.kill(sessionIdRef.current);
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
    if (!host) return;
    const ro = new ResizeObserver(() => fitRef.current?.fit());
    ro.observe(host);
    return () => ro.disconnect();
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
      <div className="termpanel__host" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  );
}
