import { useMemo, useState } from 'react';
import { useAllDiagnostics, diagnosticsCounts, type Diagnostic } from '../../lib/all-diagnostics';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { setPendingReveal } from '../../lib/reveal';
import './ProblemsPanel.css';

/**
 * v2.1 — Problems panel (parité VSCode).
 *
 * Liste tous les markers Monaco actifs (toutes langues confondues),
 * groupés par fichier, triés par sévérité (error > warning > info >
 * hint). Click sur une ligne → openFile + dispatchReveal pour
 * scroller à la ligne. Click sur un fichier → repli/expand le groupe.
 *
 * Mont monté/démonté par le toggle dans la StatusBar (item
 * « N problems » qui apparaît dès qu'il y a au moins 1 marker).
 */
export interface ProblemsPanelProps {
  height: number;
  onClose: () => void;
}

export function ProblemsPanel({ height, onClose }: ProblemsPanelProps) {
  const all = useAllDiagnostics();
  const { openFiles, openFile, setActive, activePath } = useWorkspace();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const grouped = useMemo(() => {
    const byPath = new Map<string, Diagnostic[]>();
    for (const d of all) {
      const arr = byPath.get(d.path);
      if (arr) arr.push(d);
      else byPath.set(d.path, [d]);
    }
    // Sort each file's list by severity then line.
    const sevOrder = { error: 0, warning: 1, info: 2, hint: 3 } as const;
    for (const arr of byPath.values()) {
      arr.sort((a, b) => {
        const s = sevOrder[a.severity] - sevOrder[b.severity];
        if (s !== 0) return s;
        return a.line - b.line;
      });
    }
    // Sort files : whichever has the most-severe diagnostic first,
    // then by total count, then alphabetically.
    return Array.from(byPath.entries()).sort(([pa, a], [pb, b]) => {
      const aTop = sevOrder[a[0]?.severity ?? 'hint'];
      const bTop = sevOrder[b[0]?.severity ?? 'hint'];
      if (aTop !== bTop) return aTop - bTop;
      if (a.length !== b.length) return b.length - a.length;
      return pa.localeCompare(pb);
    });
  }, [all]);

  const counts = useMemo(() => diagnosticsCounts(all), [all]);

  const toggleGroup = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const onJump = async (d: Diagnostic) => {
    // Stamp the pending reveal BEFORE opening/activating so EditorPanel's
    // consumePendingReveal effect catches it on the next render.
    setPendingReveal(d.path, d.line, d.column);
    const already = openFiles.find((f) => f.path === d.path);
    if (!already) {
      try {
        const fresh = await window.suxai.fs.readFile(d.path);
        const name = d.path.split(/[\\/]/).pop() ?? d.path;
        openFile({ path: d.path, name, content: fresh.content });
      } catch {
        /* file no longer on disk — silently ignore */
        return;
      }
    } else if (activePath !== d.path) {
      setActive(d.path);
    }
  };

  return (
    <section className="problems" style={{ height }}>
      <header className="problems__head">
        <span className="problems__title">Problems</span>
        <span className="problems__counts">
          {counts.error > 0 && <span className="problems__count problems__count--error">{counts.error} errors</span>}
          {counts.warning > 0 && <span className="problems__count problems__count--warning">{counts.warning} warnings</span>}
          {counts.info > 0 && <span className="problems__count problems__count--info">{counts.info} info</span>}
          {counts.total === 0 && <span className="problems__count problems__count--empty">No problems</span>}
        </span>
        <button className="problems__close" onClick={onClose} title="Close (Cmd+Shift+M)" aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </header>

      <div className="problems__body">
        {grouped.length === 0 ? (
          <div className="problems__empty">
            Aucun problème détecté.
            <br />
            <small>Les diagnostics TypeScript / JSON / CSS / HTML sont publiés automatiquement par Monaco au fur et à mesure que tu édites.</small>
          </div>
        ) : (
          <ul className="problems__list">
            {grouped.map(([path, items]) => {
              const isCollapsed = collapsed.has(path);
              const name = path.split(/[\\/]/).pop() ?? path;
              const dir = path.slice(0, path.length - name.length).replace(/[\\/]$/, '');
              return (
                <li key={path} className="problems__group">
                  <button
                    className="problems__group-head"
                    onClick={() => toggleGroup(path)}
                    aria-expanded={!isCollapsed}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      aria-hidden
                      className={`problems__chev${isCollapsed ? ' problems__chev--collapsed' : ''}`}
                    >
                      <path d="M2 3 L5 7 L8 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                    </svg>
                    <span className="problems__group-name">{name}</span>
                    {dir && <span className="problems__group-dir">{dir}</span>}
                    <span className="problems__group-count">{items.length}</span>
                  </button>
                  {!isCollapsed && (
                    <ul className="problems__items">
                      {items.map((d, i) => (
                        <li key={`${d.line}:${d.column}:${i}`}>
                          <button className="problems__item" onClick={() => onJump(d)}>
                            <span className={`problems__sev problems__sev--${d.severity}`} aria-hidden />
                            <span className="problems__msg">{d.message}</span>
                            <span className="problems__loc">[{d.line}, {d.column}]</span>
                            {d.source && <span className="problems__src">{d.source}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
