import { useEffect, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSettings } from '../../lib/settings';
import { useGitBranchState } from '../../lib/git';
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
}

export function StatusBar({ onToggleTerminal, terminalOpen }: StatusBarProps = {}) {
  const { activeFile, workspaceRoot } = useWorkspace();
  const [settings, update] = useSettings();
  const [pos, setPos] = useState<Pos>({ line: 1, column: 1, selection: 0 });
  const branchState = useGitBranchState(workspaceRoot);

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
