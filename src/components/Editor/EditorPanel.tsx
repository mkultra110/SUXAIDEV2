import { useCallback, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import './EditorPanel.css';

export function EditorPanel() {
  const { openFiles, activePath, activeFile, setActive, closeFile, updateActiveContent, setSelection } =
    useWorkspace();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

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
          { token: 'string', foreground: '86efac' },
          { token: 'number', foreground: 'fbbf24' },
          { token: 'type', foreground: '7dd3fc' },
        ],
        colors: {
          'editor.background': '#0b0f17',
          'editor.foreground': '#e8ecf4',
          'editor.lineHighlightBackground': '#111828',
          'editorLineNumber.foreground': '#5a6378',
          'editorLineNumber.activeForeground': '#8a95aa',
          'editor.selectionBackground': '#2d3b5c',
          'editorCursor.foreground': '#7d82f8',
          'editorIndentGuide.background': '#1a2338',
          'editorIndentGuide.activeBackground': '#2b3551',
          'scrollbarSlider.background': '#ffffff14',
          'scrollbarSlider.hoverBackground': '#ffffff1f',
          'scrollbarSlider.activeBackground': '#ffffff2b',
        },
      });
      monaco.editor.setTheme('suxai-dark');

      editor.onDidChangeCursorSelection((e) => {
        const model = editor.getModel();
        if (!model) return;
        const text = model.getValueInRange(e.selection);
        setSelection(text);
      });
    },
    [setSelection],
  );

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

      <div className="editor__body">
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
              fontSize: 13,
              fontLigatures: true,
              minimap: { enabled: false },
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              padding: { top: 14, bottom: 14 },
              scrollBeyondLastLine: false,
              renderLineHighlight: 'all',
              lineNumbersMinChars: 3,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
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
