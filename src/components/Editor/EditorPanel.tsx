import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { DiffView } from './DiffView';
import { emitAiCommand } from '../../lib/commands';
import { useSettings } from '../../lib/settings';
import './EditorPanel.css';

interface ActionBarPos {
  top: number;
  left: number;
}

export function EditorPanel() {
  const {
    openFiles,
    activePath,
    activeFile,
    setActive,
    closeFile,
    updateActiveContent,
    setSelection,
    pendingDiff,
  } = useWorkspace();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [actionBar, setActionBar] = useState<ActionBarPos | null>(null);
  const [settings] = useSettings();

  const onMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Subtle custom theme matching our palette.
      monaco.editor.defineTheme('suxai-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: '', foreground: 'e8ecf4', background: '0b0f17' },
          { token: 'comment', foreground: '5a6378', fontStyle: 'italic' },
          { token: 'keyword', foreground: '7d82f8' },
          { token: 'keyword.control', foreground: 'a78bfa' },
          { token: 'string', foreground: '86efac' },
          { token: 'string.escape', foreground: '34d399' },
          { token: 'number', foreground: 'fbbf24' },
          { token: 'type', foreground: '7dd3fc' },
          { token: 'type.identifier', foreground: '7dd3fc' },
          { token: 'function', foreground: 'fde68a' },
          { token: 'variable', foreground: 'e8ecf4' },
          { token: 'variable.parameter', foreground: 'fbcfe8' },
          { token: 'tag', foreground: 'f472b6' },
          { token: 'attribute.name', foreground: 'fbbf24' },
          { token: 'attribute.value', foreground: '86efac' },
          { token: 'delimiter', foreground: '8a95aa' },
          { token: 'operator', foreground: 'a5b4fc' },
        ],
        colors: {
          'editor.background': '#0b0f17',
          'editor.foreground': '#e8ecf4',
          'editor.lineHighlightBackground': '#10162480',
          'editor.lineHighlightBorder': '#00000000',
          'editorLineNumber.foreground': '#455065',
          'editorLineNumber.activeForeground': '#9aa5bd',
          'editor.selectionBackground': '#3b4b75aa',
          'editor.inactiveSelectionBackground': '#2d3b5c66',
          'editor.selectionHighlightBackground': '#3b4b7555',
          'editor.wordHighlightBackground': '#3b4b7544',
          'editor.wordHighlightStrongBackground': '#3b4b7566',
          'editorCursor.foreground': '#a5b4fc',
          'editorBracketMatch.background': '#2b3551',
          'editorBracketMatch.border': '#7d82f866',
          'editorIndentGuide.background': '#182039',
          'editorIndentGuide.activeBackground': '#2d3b5c',
          'editorWhitespace.foreground': '#1a233880',
          'editorGutter.background': '#0b0f17',
          'scrollbarSlider.background': '#ffffff10',
          'scrollbarSlider.hoverBackground': '#ffffff1c',
          'scrollbarSlider.activeBackground': '#ffffff28',
          'editorOverviewRuler.border': '#00000000',
        },
      });
      monaco.editor.setTheme('suxai-dark');

      editor.onDidChangeCursorSelection((e) => {
        const model = editor.getModel();
        if (!model) return;
        const text = model.getValueInRange(e.selection);
        setSelection(text);

        // Show a floating code-action bar above the selection when the
        // user has actually highlighted something.
        if (!text || text.trim().length < 2) {
          setActionBar(null);
          return;
        }
        const editorDom = editor.getDomNode();
        const host = containerRef.current;
        if (!editorDom || !host) {
          setActionBar(null);
          return;
        }
        const startPos = editor.getTopForLineNumber(e.selection.startLineNumber);
        const scrollTop = editor.getScrollTop();
        const layoutInfo = editor.getLayoutInfo();
        const editorRect = editorDom.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const top =
          editorRect.top - hostRect.top + (startPos - scrollTop) - 38;
        const left =
          editorRect.left - hostRect.left + layoutInfo.contentLeft + 8;
        setActionBar({ top: Math.max(8, top), left });
      });

      editor.onDidScrollChange(() => {
        // Selection can still be active but the viewport moved — re-emit
        // a synthetic selection event to refresh the toolbar position.
        const sel = editor.getSelection();
        const model = editor.getModel();
        if (!sel || !model) return;
        const text = model.getValueInRange(sel);
        if (!text || text.trim().length < 2) {
          setActionBar(null);
          return;
        }
        const editorDom = editor.getDomNode();
        const host = containerRef.current;
        if (!editorDom || !host) return;
        const startPos = editor.getTopForLineNumber(sel.startLineNumber);
        const scrollTop = editor.getScrollTop();
        const layoutInfo = editor.getLayoutInfo();
        const editorRect = editorDom.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const top =
          editorRect.top - hostRect.top + (startPos - scrollTop) - 38;
        const left =
          editorRect.left - hostRect.left + layoutInfo.contentLeft + 8;
        setActionBar({ top: Math.max(8, top), left });
      });
    },
    [setSelection],
  );

  // Hide the action bar when the active file changes.
  useEffect(() => {
    setActionBar(null);
  }, [activePath]);

  return (
    <section className="editor">
      <div className="editor__tabs" role="tablist">
        {openFiles.length === 0 && <div className="editor__empty-tab">No files open</div>}
        {openFiles.map((f) => (
          <div
            key={f.path}
            role="tab"
            aria-selected={f.path === activePath}
            className={`editor__tab ${f.path === activePath ? 'editor__tab--active' : ''}`}
            onClick={() => setActive(f.path)}
            title={f.path}
          >
            <span className="editor__tab-name">{f.name}{f.dirty ? ' •' : ''}</span>
            <button
              className="editor__tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(f.path);
              }}
              aria-label={`Close ${f.name}`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" /></svg>
            </button>
          </div>
        ))}
      </div>

      <div className="editor__body" ref={containerRef}>
        {pendingDiff && <DiffView diff={pendingDiff} />}
        {actionBar && !pendingDiff && (
          <div
            className="editor__actions"
            style={{ top: actionBar.top, left: actionBar.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              onClick={() => emitAiCommand({ command: 'explain' })}
              title="Explain selection"
            >
              Explain
            </button>
            <button
              type="button"
              onClick={() => emitAiCommand({ command: 'refactor' })}
              title="Refactor selection"
            >
              Refactor
            </button>
            <button
              type="button"
              onClick={() => emitAiCommand({ command: 'fix' })}
              title="Fix bugs in selection"
            >
              Fix
            </button>
            <button
              type="button"
              onClick={() => emitAiCommand({ command: 'optimize' })}
              title="Optimize selection"
            >
              Optimize
            </button>
          </div>
        )}
        {activeFile ? (
          <Editor
            key={activeFile.path}
            height="100%"
            language={activeFile.language ?? 'plaintext'}
            value={activeFile.content}
            onChange={(v) => updateActiveContent(v ?? '')}
            onMount={onMount}
            options={{
              fontFamily: 'JetBrains Mono, Fira Code, Menlo, monospace',
              fontSize: settings.fontSize,
              fontLigatures: true,
              minimap: { enabled: settings.minimap },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 14, bottom: 14 },
              scrollBeyondLastLine: false,
              renderLineHighlight: 'all',
              lineNumbersMinChars: 3,
              automaticLayout: true,
              tabSize: settings.tabSize,
              wordWrap: settings.wordWrap ? 'on' : 'off',
              guides: { indentation: true, bracketPairs: true },
            }}
          />
        ) : (
          <EditorWelcome />
        )}
      </div>
    </section>
  );
}

function EditorWelcome() {
  return (
    <div className="editor__welcome">
      <div className="editor__welcome-card">
        <div className="editor__welcome-brand">SUXAI</div>
        <h2>Start coding with an AI pair</h2>
        <p>Open a folder or drop a file anywhere to get started. Select code and ask the AI to explain, refactor, or fix.</p>
        <div className="editor__welcome-shortcuts">
          <kbd>Drag &amp; drop</kbd>
          <span>any file into this window</span>
        </div>
      </div>
    </div>
  );
}
