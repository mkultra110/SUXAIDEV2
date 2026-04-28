import { useEffect, useMemo, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSettings } from '../../lib/settings';
import { useGitBranchState } from '../../lib/git';
import { useAllDiagnostics, diagnosticsCounts } from '../../lib/all-diagnostics';
import { openBranchPicker } from '../Sidebar/BranchPicker';
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
}

export function StatusBar({
  onToggleTerminal,
  terminalOpen,
  onToggleProblems,
  problemsOpen,
}: StatusBarProps = {}) {
  const { activeFile, workspaceRoot } = useWorkspace();
  const [settings, update] = useSettings();
  const [pos, setPos] = useState<Pos>({ line: 1, column: 1, selection: 0 });
  const branchState = useGitBranchState(workspaceRoot);
  const diagnostics = useAllDiagnostics();
  const diagCounts = useMemo(() => diagnosticsCounts(diagnostics), [diagnostics]);

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
        {onToggleTerminal && (
          <button
            type="button"
            className={`statusbar__item statusbar__btn ${terminalOpen ? 'statusbar__btn--active' : ''}`}
            onClick={onToggleTerminal}
            title="Toggle terminal (Ctrl+`)"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden style={{ marginRight: 4 }}>
              <path d="M4 17l6-6-6-6M12 19h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
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
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden style={{ marginRight: 4 }}>
              <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="6" cy="19" r="2" stroke="currentColor" strokeWidth="1.7" />
              <circle cx="18" cy="12" r="2" stroke="currentColor" strokeWidth="1.7" />
              <path d="M6 7v10 M8 19h2a4 4 0 0 0 4-4v-3 M8 5h2a4 4 0 0 1 4 4v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
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
        {/* v2.1 — Problems panel toggle. Toujours visible (cohérent
            avec VSCode) ; le badge à 0 reste muet en gris. */}
        {onToggleProblems && (
          <button
            type="button"
            className={`statusbar__item statusbar__btn statusbar__problems ${problemsOpen ? 'statusbar__btn--active' : ''}`}
            onClick={onToggleProblems}
            title={`Problems (Ctrl+Shift+M) — ${diagCounts.error} errors · ${diagCounts.warning} warnings`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden style={{ marginRight: 4 }}>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
              <line x1="12" y1="8" x2="12" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <line x1="12" y1="16" x2="12" y2="16.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
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
          </>
        )}
      </div>
    </footer>
  );
}
