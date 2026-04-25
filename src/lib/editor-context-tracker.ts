import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { useWorkspace } from '../contexts/WorkspaceContext';

/**
 * Hook that wires Monaco editor events to the workspace's
 * `editorContext` slice. Mount this once per active editor (in
 * EditorPanel.onMount). It handles:
 *   - active file changes
 *   - cursor position
 *   - selection (text trimmed to 4 KB)
 *   - visible viewport range
 *   - recent edits ring buffer (5 last)
 *   - recently viewed files (10 last, dedupe via the context's ring)
 *   - LSP-ish diagnostics from monaco.editor.onDidChangeMarkers
 *
 * Throttled at ~30 fps via requestAnimationFrame to avoid spamming
 * React state updates while the user drags a selection.
 *
 * Cleanup: every Monaco subscription returns an IDisposable that we
 * collect and dispose on unmount.
 */
export function useEditorContextTracker(
  editor: monaco.editor.IStandaloneCodeEditor | null,
): void {
  const { updateEditorContext, recordEdit, activeFile } = useWorkspace();
  // Mirror the canonical workspace path so the Monaco event
  // handlers can resolve their model URI to a real disk path.
  // Monaco standalone uses `inmemory:` URIs whose fsPath is empty,
  // so model.uri.fsPath alone gives garbage. The WorkspaceContext
  // knows the absolute path of the file currently being shown, so
  // we use that as the canonical answer for any "what file is this?"
  // question downstream.
  const activeFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    activeFilePathRef.current = activeFile?.path ?? null;
  }, [activeFile?.path]);

  useEffect(() => {
    if (!editor) return;
    const disposables: monaco.IDisposable[] = [];

    let rafId = 0;
    let pending: Parameters<typeof updateEditorContext>[0] | null = null;
    const scheduleFlush = (patch: Parameters<typeof updateEditorContext>[0]) => {
      pending = pending ? { ...pending, ...patch } : patch;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (pending) {
          updateEditorContext(pending);
          pending = null;
        }
      });
    };

    const collectAll = () => {
      const model = editor.getModel();
      const sel = editor.getSelection();
      const pos = editor.getPosition();
      const visibleRanges = editor.getVisibleRanges();
      const visible = visibleRanges[0];
      // Prefer the canonical workspace path. Falls back to the
      // model URI only when no file is open (e.g. an untitled
      // buffer the user just created).
      const path = activeFilePathRef.current
        ?? (model && model.uri.scheme === 'file'
          ? model.uri.fsPath
          : model
          ? model.uri.path
          : null);
      const selectionPayload =
        sel && model && !sel.isEmpty()
          ? {
              startLine: sel.startLineNumber,
              startColumn: sel.startColumn,
              endLine: sel.endLineNumber,
              endColumn: sel.endColumn,
              // 256 KB selection slice (v0.11.1, was 64 KB). Covers
              // even very long "select the whole file then ask for
              // changes" workflows without hitting the limit. Heavy
              // selections are still truncated and the model sees
              // the boundary in the <additional_data> XML.
              text: model.getValueInRange(sel).slice(0, 256 * 1024),
            }
          : null;
      scheduleFlush({
        activeFilePath: path,
        cursorPosition: pos
          ? { line: pos.lineNumber, column: pos.column }
          : null,
        selection: selectionPayload,
        visibleRange: visible
          ? { startLine: visible.startLineNumber, endLine: visible.endLineNumber }
          : null,
      });
    };

    disposables.push(editor.onDidChangeModel(collectAll));
    disposables.push(editor.onDidChangeCursorSelection(collectAll));
    disposables.push(editor.onDidChangeCursorPosition(collectAll));
    disposables.push(editor.onDidScrollChange(collectAll));
    disposables.push(editor.onDidFocusEditorWidget(collectAll));

    // Recent edits: any model content change made by the user (not by
    // a programmatic setValue from the diff system, which runs through
    // executeEdits but still fires this event — we accept the noise).
    disposables.push(
      editor.onDidChangeModelContent((e) => {
        // Same resolution rule as collectAll: trust the workspace
        // path over the model URI. Without this, recentEdits is
        // populated with `/0`-style fake paths that look opaque to
        // the model and make follow-ups like "the file I just
        // edited" useless.
        const path = activeFilePathRef.current;
        if (!path) return;
        const firstChange = e.changes[0];
        if (!firstChange) return;
        recordEdit(path, firstChange.range.startLineNumber);
      }),
    );

    // Diagnostics from Monaco markers (TypeScript, ESLint via
    // language services that publish markers — covers the basic cases
    // without us having to wire a real LSP client).
    const refreshMarkers = () => {
      const model = editor.getModel();
      if (!model) {
        scheduleFlush({ diagnostics: [] });
        return;
      }
      const markers = monaco.editor.getModelMarkers({ resource: model.uri });
      // Use the canonical workspace path so the model can correlate
      // diagnostics with the same path it'd pass to read_file.
      const path = activeFilePathRef.current
        ?? (model.uri.scheme === 'file' ? model.uri.fsPath : model.uri.path);
      scheduleFlush({
        diagnostics: markers.slice(0, 20).map((m) => ({
          path,
          severity:
            m.severity === monaco.MarkerSeverity.Error
              ? 'error'
              : m.severity === monaco.MarkerSeverity.Warning
              ? 'warning'
              : m.severity === monaco.MarkerSeverity.Info
              ? 'info'
              : 'hint',
          message: m.message,
          line: m.startLineNumber,
          column: m.startColumn,
        })),
      });
    };
    disposables.push(monaco.editor.onDidChangeMarkers(() => refreshMarkers()));

    // Initial population.
    collectAll();
    refreshMarkers();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      for (const d of disposables) {
        try { d.dispose(); } catch { /* */ }
      }
    };
  }, [editor, updateEditorContext, recordEdit]);
}
