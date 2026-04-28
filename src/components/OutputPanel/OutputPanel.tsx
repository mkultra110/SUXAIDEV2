import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutput, useOutputSources, clearOutput, type OutputLine } from '../../lib/output';
import { AtelierIcon } from '../ui/AtelierIcon';
import './OutputPanel.css';

/**
 * v3.6 — Output panel (parité VSCode A7).
 *
 * Bottom panel persistent qui agrège les sortes des sources
 * registered (tasks, agent stdout, build, etc.). UX :
 *   - Source picker dropdown en haut à gauche
 *   - Auto-scroll sticky bottom (sauf si l'utilisateur a scrollé up)
 *   - Clear + close en haut à droite
 *   - Rendering monospace, severity tinted (stdout / warn / error)
 *
 * Mont monté/démonté depuis IDELayout selon outputOpen state.
 * Toggle StatusBar + Cmd+Shift+U + entrée CommandPalette.
 */
export interface OutputPanelProps {
  height: number;
  onClose: () => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function OutputPanel({ height, onClose }: OutputPanelProps) {
  const sources = useOutputSources();
  const [active, setActive] = useState<string | null>(null);

  // Auto-pick a source on first appearance / when current vanishes.
  useEffect(() => {
    if (sources.length === 0) {
      setActive(null);
      return;
    }
    if (!active || !sources.includes(active)) {
      setActive(sources[0]);
    }
  }, [sources, active]);

  const lines = useOutput(active);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // Auto-scroll : on append, only scroll-to-bottom if the user is
  // already pinned at bottom. If they scrolled up to inspect, leave
  // them alone.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (stickRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [lines.length]);

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const atBottom =
      body.scrollHeight - body.scrollTop - body.clientHeight < 4;
    stickRef.current = atBottom;
  };

  const counts = useMemo(() => {
    let warns = 0, errs = 0;
    for (const l of lines) {
      if (l.level === 'warn') warns++;
      else if (l.level === 'error' || l.level === 'stderr') errs++;
    }
    return { warns, errs };
  }, [lines]);

  return (
    <section className="output" style={{ height }}>
      <header className="output__head">
        <span className="output__title">Output</span>
        <select
          className="output__source"
          value={active ?? ''}
          onChange={(e) => setActive(e.target.value || null)}
          disabled={sources.length === 0}
          title="Output source"
        >
          {sources.length === 0 ? (
            <option value="">(no sources)</option>
          ) : (
            sources.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))
          )}
        </select>
        {(counts.warns > 0 || counts.errs > 0) && (
          <span className="output__counts">
            {counts.errs > 0 && <span className="output__count output__count--err">{counts.errs}</span>}
            {counts.warns > 0 && <span className="output__count output__count--warn">{counts.warns}</span>}
          </span>
        )}
        <span className="output__spacer" />
        <button
          className="output__action"
          onClick={() => active && clearOutput(active)}
          disabled={!active || lines.length === 0}
          title="Clear output"
          aria-label="Clear"
        >
          <AtelierIcon name="i-close" size={11} />
          <span style={{ marginLeft: 4 }}>Clear</span>
        </button>
        <button
          className="output__close"
          onClick={onClose}
          title="Close (Ctrl+Shift+U)"
          aria-label="Close"
        >
          <AtelierIcon name="i-close" size={12} />
        </button>
      </header>
      <div
        className="output__body"
        ref={bodyRef}
        onScroll={onScroll}
      >
        {!active ? (
          <div className="output__empty">
            Aucune source d'output encore active.
            <br />
            <small>Une tâche, un build, ou un tool call de l'agent fera apparaître son flux ici.</small>
          </div>
        ) : lines.length === 0 ? (
          <div className="output__empty">
            <em>{active}</em> n'a encore rien émis.
          </div>
        ) : (
          <ul className="output__list">
            {lines.map((l, i) => (
              <Row key={i} line={l} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Row({ line }: { line: OutputLine }) {
  return (
    <li className={`output__row output__row--${line.level}`}>
      <span className="output__ts">{fmtTime(line.ts)}</span>
      <span className="output__text">{line.text || ' '}</span>
    </li>
  );
}
