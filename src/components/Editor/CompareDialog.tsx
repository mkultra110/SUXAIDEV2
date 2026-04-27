import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DiffEditor } from '@monaco-editor/react';
import { onCompareOpen } from '../../lib/compare';
import './CompareDialog.css';

/**
 * v0.16.8 — Compare two files modal. Listens for the global
 * 'suxai:compare-open' event (dispatched by the sidebar context
 * menu) and renders a Monaco DiffEditor side-by-side.
 *
 * The modal is a portal to document.body so it sits above everything
 * else and isn't clipped by react-resizable-panels overflow:hidden.
 */

interface State {
  pathA: string;
  pathB: string;
  contentA: string;
  contentB: string;
  errorMsg: string | null;
}

function langFromPath(p: string): string {
  const ext = p.toLowerCase().match(/\.([^.\\/]+)$/)?.[1] ?? '';
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'jsx': return 'javascript';
    case 'json': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'css': return 'css';
    case 'scss': case 'sass': return 'scss';
    case 'html': case 'htm': return 'html';
    case 'py': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return 'cpp';
    case 'cs': return 'csharp';
    case 'php': return 'php';
    case 'rb': return 'ruby';
    case 'sql': return 'sql';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'yml': case 'yaml': return 'yaml';
    case 'xml': return 'xml';
    case 'lua': return 'lua';
    default: return 'plaintext';
  }
}

export function CompareDialog() {
  const [state, setState] = useState<State | null>(null);

  // Subscribe to compare-open events and load both file contents.
  useEffect(() => {
    return onCompareOpen(async ({ a, b }) => {
      setState({ pathA: a, pathB: b, contentA: '', contentB: '', errorMsg: 'Loading…' });
      try {
        const [fa, fb] = await Promise.all([
          window.suxai.fs.readFile(a),
          window.suxai.fs.readFile(b),
        ]);
        setState({
          pathA: a,
          pathB: b,
          contentA: fa.content,
          contentB: fb.content,
          errorMsg: null,
        });
      } catch (err) {
        setState({
          pathA: a,
          pathB: b,
          contentA: '',
          contentB: '',
          errorMsg: (err as Error).message ?? 'Failed to read one of the files',
        });
      }
    });
  }, []);

  // Esc closes — capture phase to beat Monaco's own bindings.
  useEffect(() => {
    if (!state) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setState(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [state]);

  if (!state) return null;

  const fileA = state.pathA.split(/[\\/]/).pop() ?? state.pathA;
  const fileB = state.pathB.split(/[\\/]/).pop() ?? state.pathB;
  const lang = langFromPath(state.pathA);

  return createPortal(
    <div className="cmp__overlay" role="dialog" aria-modal="true" onClick={() => setState(null)}>
      <div className="cmp" onClick={(e) => e.stopPropagation()}>
        <div className="cmp__head">
          <div className="cmp__title">
            <span className="cmp__title-icon" aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 19h4a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4M9 21V3M15 3v18" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </span>
            Compare
          </div>
          <div className="cmp__paths">
            <span className="cmp__path cmp__path--a" title={state.pathA}>
              <span className="cmp__path-label">A</span>
              {fileA}
            </span>
            <button
              type="button"
              className="cmp__swap"
              onClick={() => {
                setState((s) => s && {
                  ...s,
                  pathA: s.pathB,
                  pathB: s.pathA,
                  contentA: s.contentB,
                  contentB: s.contentA,
                });
              }}
              title="Swap A ↔ B"
              aria-label="Swap A and B"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M7 4l-4 4 4 4M3 8h13M17 12l4 4-4 4M21 16H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="cmp__path cmp__path--b" title={state.pathB}>
              <span className="cmp__path-label">B</span>
              {fileB}
            </span>
          </div>
          <button
            type="button"
            className="cmp__close"
            onClick={() => setState(null)}
            title="Close (Esc)"
            aria-label="Close"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="cmp__body">
          {state.errorMsg ? (
            <div className="cmp__error">{state.errorMsg}</div>
          ) : (
            <DiffEditor
              height="100%"
              language={lang}
              original={state.contentA}
              modified={state.contentB}
              theme="suxai-dark"
              options={{
                readOnly: true,
                renderSideBySide: true,
                renderOverviewRuler: true,
                fontFamily: 'JetBrains Mono, Fira Code, Menlo, monospace',
                fontSize: 12.5,
                fontLigatures: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderWhitespace: 'selection',
              }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
