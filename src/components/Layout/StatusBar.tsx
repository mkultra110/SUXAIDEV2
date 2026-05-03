import { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSettings } from '../../lib/settings';
import { useGitBranchState } from '../../lib/git';
import { useAllDiagnostics, diagnosticsCounts } from '../../lib/all-diagnostics';
import { useServerHealth } from '../../lib/server-health';
import { openBranchPicker } from '../Sidebar/BranchPicker';
import { AtelierIcon } from '../ui/AtelierIcon';
import './StatusBar.css';

interface Pos {
  line: number;
  column: number;
  selection: number;
}

interface StatusBarProps {
  onToggleTerminal?: () => void;
  terminalOpen?: boolean;
  /** v2.1 — Problems panel toggle (Cmd/Ctrl+Shift+M). */
  onToggleProblems?: () => void;
  problemsOpen?: boolean;
  /** v3.6 — Output panel toggle (Cmd/Ctrl+Shift+U). */
  onToggleOutput?: () => void;
  outputOpen?: boolean;
}

export function StatusBar({
  onToggleTerminal,
  terminalOpen,
  onToggleProblems,
  problemsOpen,
  onToggleOutput,
  outputOpen,
}: StatusBarProps = {}) {
  const { activeFile, workspaceRoot } = useWorkspace();
  const [settings, update] = useSettings();
  const [pos, setPos] = useState<Pos>({ line: 1, column: 1, selection: 0 });
  const branchState = useGitBranchState(workspaceRoot);
  const diagnostics = useAllDiagnostics();
  const diagCounts = useMemo(() => diagnosticsCounts(diagnostics), [diagnostics]);
  // v4.3.5 — server health pill. Silencieux quand 'ok'/'unknown',
  // visible quand 'degraded' ou 'down'. Permet au user de voir
  // immédiatement « c'est pas mon réseau, c'est le serveur » avant
  // que /auth/login timeout (cf. incident 2026-05-01).
  const health = useServerHealth();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Pos>).detail;
      if (detail) setPos(detail);
    };
    window.addEventListener('suxai:cursor', handler);
    return () => window.removeEventListener('suxai:cursor', handler);
  }, []);

  return (
    <footer className="statusbar">
      <div className="statusbar__group">
        {/* v4.3.5 — server-health pill. Visible UNIQUEMENT en
            'degraded' ou 'down' pour rester silencieux quand tout
            va bien. Click → ne fait rien (passif), le tooltip
            donne les détails (free MB, used %, version). */}
        {(health.status === 'degraded' || health.status === 'down') && (
          <span
            className={`statusbar__health statusbar__health--${health.status}`}
            title={
              health.status === 'down'
                ? 'Server unreachable — check connection or VPS status'
                : `Server degraded${
                    typeof health.diskUsedPct === 'number'
                      ? ` — disk ${health.diskUsedPct}% used`
                      : ''
                  }${
                    typeof health.diskFreeMB === 'number'
                      ? ` (${health.diskFreeMB}MB free)`
                      : ''
                  }`
            }
          >
            <span className="statusbar__health-dot" aria-hidden />
            {health.status === 'down' ? 'Server offline' : 'Server degraded'}
          </span>
        )}
        {onToggleTerminal && (
          <button
            type="button"
            className={`statusbar__item statusbar__btn ${terminalOpen ? 'statusbar__btn--active' : ''}`}
            onClick={onToggleTerminal}
            title="Toggle terminal (Ctrl+`)"
          >
            <AtelierIcon name="i-terminal" size={11} className="statusbar__icon" />
            Terminal
          </button>
        )}
        {/* v0.16.16 — Git branch indicator. Click → BranchPicker. Shows
            ahead/behind counts as compact ↓N / ↑N suffix when relevant. */}
        {branchState.branch && (
          <button
            type="button"
            className="statusbar__item statusbar__btn statusbar__branch"
            onClick={() => openBranchPicker()}
            title={`Switch branch (current: ${branchState.branch})`}
          >
            <AtelierIcon name="i-git-branch" size={11} className="statusbar__icon" />
            {branchState.branch}
            {branchState.behind > 0 && (
              <span className="statusbar__branch-count">↓{branchState.behind}</span>
            )}
            {branchState.ahead > 0 && (
              <span className="statusbar__branch-count">↑{branchState.ahead}</span>
            )}
          </button>
        )}
        {activeFile && <span className="statusbar__item">{activeFile.language ?? 'plaintext'}</span>}
        {/* v3.6 (A7) — Output panel toggle. Affiché à côté du Problems
            quand le hôte le passe. Hotkey Ctrl+Shift+U géré par
            IDELayout, ce bouton est la voie click. */}
        {onToggleOutput && (
          <button
            type="button"
            className={`statusbar__item statusbar__btn ${outputOpen ? 'statusbar__btn--active' : ''}`}
            onClick={onToggleOutput}
            title="Output (Ctrl+Shift+U)"
          >
            <AtelierIcon name="i-log" size={11} className="statusbar__icon" />
            Output
          </button>
        )}
        {/* v2.1 — Problems panel toggle. Toujours visible (cohérent
            avec VSCode) ; le badge à 0 reste muet en gris. */}
        {onToggleProblems && (
          <button
            type="button"
            className={`statusbar__item statusbar__btn statusbar__problems ${problemsOpen ? 'statusbar__btn--active' : ''}`}
            onClick={onToggleProblems}
            title={`Problems (Ctrl+Shift+M) — ${diagCounts.error} errors · ${diagCounts.warning} warnings`}
          >
            <AtelierIcon name="i-warning" size={11} className="statusbar__icon" />
            <span className={`statusbar__problems-count statusbar__problems-count--err ${diagCounts.error === 0 ? 'statusbar__problems-count--zero' : ''}`}>
              {diagCounts.error}
            </span>
            <span className={`statusbar__problems-count statusbar__problems-count--warn ${diagCounts.warning === 0 ? 'statusbar__problems-count--zero' : ''}`}>
              {diagCounts.warning}
            </span>
          </button>
        )}
      </div>
      <div className="statusbar__spacer" />
      <div className="statusbar__group">
        {activeFile && (
          <>
            <button
              type="button"
              className="statusbar__item statusbar__btn"
              title="Change indent size in settings"
              onClick={() => window.dispatchEvent(new CustomEvent('suxai:open-settings'))}
            >
              Spaces: {settings.tabSize}
            </button>
            <button
              type="button"
              className="statusbar__item statusbar__btn"
              title={settings.wordWrap ? 'Word wrap on' : 'Word wrap off'}
              onClick={() => update({ wordWrap: !settings.wordWrap })}
            >
              {settings.wordWrap ? 'Wrap' : 'No wrap'}
            </button>
            <button
              type="button"
              className={`statusbar__item statusbar__btn ${settings.minimap ? 'statusbar__btn--active' : ''}`}
              title="Toggle minimap"
              onClick={() => update({ minimap: !settings.minimap })}
            >
              Minimap
            </button>
            <span className="statusbar__item">
              Ln {pos.line}, Col {pos.column}
              {pos.selection > 0 && ` · ${pos.selection} chars`}
            </span>
            {/* v3.5 (A8) — Encoding indicator. Shows the encoding
                detected at read time. UTF-8 ± BOM aujourd'hui ;
                reste read-only (basculer l'encoding nécessite une
                conversion iconv hors scope). */}
            {activeFile.encoding && (
              <span className="statusbar__item" title={`Encoding: ${activeFile.encoding}`}>
                {activeFile.encoding === 'UTF-8 with BOM' ? 'UTF-8 BOM' : 'UTF-8'}
              </span>
            )}
            {/* v3.5 (A8) — EOL indicator. Cliquable : toggle entre LF
                et CRLF, persiste côté main process via fs:set-eol. La
                prochaine writeFile sérialise avec le nouvel EOL. */}
            {activeFile.eol && !activeFile.untitled && (
              <button
                type="button"
                className="statusbar__item statusbar__btn"
                title={`End of Line — click to switch to ${activeFile.eol === 'LF' ? 'CRLF' : 'LF'}`}
                onClick={async () => {
                  const next = activeFile.eol === 'LF' ? 'CRLF' : 'LF';
                  try {
                    const res = await window.suxai.fs.setEol({ path: activeFile.path, eol: next });
                    if (res.ok) {
                      window.dispatchEvent(
                        new CustomEvent<{ path: string; eol: 'LF' | 'CRLF' }>(
                          'suxai:eol-changed',
                          { detail: { path: activeFile.path, eol: next } },
                        ),
                      );
                    }
                  } catch { /* swallow — surfaced via IPC error */ }
                }}
              >
                {activeFile.eol}
              </button>
            )}
          </>
        )}
      </div>
    </footer>
  );
}
