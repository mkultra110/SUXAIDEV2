import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { InlineDiff } from './InlineDiff';
import { InlineEdit } from './InlineEdit';
import { Breadcrumbs } from './Breadcrumbs';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { emitAiCommand } from '../../lib/commands';
import { useSettings } from '../../lib/settings';
import { useEditorContextTracker } from '../../lib/editor-context-tracker';
import { registerTabCompletion } from '../../lib/tab-completion';
import { consumePendingReveal } from '../../lib/reveal';
import { useRecent, removeRecentIfMissing } from '../../lib/recent';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import './EditorPanel.css';

interface ActionBarPos {
  top: number;
  left: number;
}

/**
 * v0.14.2 — Cursor-style multi-file context for tab autocomplete.
 *
 * Builds a small bag of code snippets from the OTHER open tabs (i.e.
 * everything except the active file) so the FIM model has enough
 * surrounding context to produce completions that reference imports,
 * sibling helpers, types, etc. defined elsewhere in the project.
 *
 * Keeps the payload tight:
 *   - up to 3 other tabs (most-recently opened first; openFiles[] is
 *     ordered by tab open order and untouched on re-activation)
 *   - 1.2 KB per file taken from the END (most recent edits land
 *     near the bottom for the kind of code people are usually
 *     writing)
 *   - 4 KB total cap; anything bigger gets sliced off
 *
 * Returns null when there's nothing useful (only the active file
 * open, all peers untitled-empty) so the lib can skip the field
 * entirely.
 */
function buildRelatedContext(
  openFiles: import('../../contexts/WorkspaceContext').OpenFile[],
  activePath: string | null,
): string | null {
  const peers = openFiles
    .filter((f) => f.path !== activePath && f.content && f.content.length > 0)
    .slice(-3); // last 3 = most-recently-opened
  if (peers.length === 0) return null;
  const PER_FILE_CAP = 1200;
  const TOTAL_CAP = 4000;
  const parts: string[] = [];
  let budget = TOTAL_CAP;
  for (const f of peers) {
    if (budget <= 0) break;
    const tail = f.content.slice(-PER_FILE_CAP);
    const header = `// File: ${f.name}\n`;
    const block = header + tail.trimStart() + '\n';
    if (block.length > budget) {
      parts.push(block.slice(0, budget));
      budget = 0;
    } else {
      parts.push(block);
      budget -= block.length;
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export function EditorPanel() {
  const {
    openFiles,
    activePath,
    activeFile,
    setActive,
    closeFile,
    closeOthers,
    closeToTheRight,
    closeAll,
    togglePin,
    reorderTab,
    updateActiveContent,
    setSelection,
    pendingDiff,
    newUntitled,
    saveActiveFile,
  } = useWorkspace();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  // Mirror of editorRef.current in state, used to drive the editor
  // context tracker hook. Refs alone don't trigger the hook's
  // dependency array so we need a real React value here.
  const [trackedEditor, setTrackedEditor] = useState<Parameters<OnMount>[0] | null>(null);
  useEditorContextTracker(trackedEditor);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [actionBar, setActionBar] = useState<ActionBarPos | null>(null);
  const [settings] = useSettings();
  const toast = useToast();
  const { token } = useAuth();

  // Register Monaco's InlineCompletionsProvider once per session.
  // Stable refs are read on demand via the closure — re-registering
  // would tear down active ghost text on every settings tweak.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => {
    const dispose = registerTabCompletion({
      getToken: () => tokenRef.current ?? null,
      isEnabled: () => settingsRef.current.tabCompletion !== false,
      // v0.14.2 — Cursor-style multi-file context. Pulls snippets
      // from up to 3 other open tabs and sends them as
      // `related_context` to /ai/complete so Haiku can produce
      // completions aware of the surrounding code (imports, sibling
      // helpers, types declared in another file). Capped tightly to
      // keep latency low.
      getRelatedContext: () => buildRelatedContext(
        openFilesRef.current,
        activeFileRef.current?.path ?? null,
      ),
    });
    return () => { try { dispose.dispose(); } catch { /* */ } };
  }, []);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [zoomOffset, setZoomOffset] = useState(0);
  const [inlineEdit, setInlineEdit] = useState<{
    top: number;
    left: number;
    width: number;
    text: string;
  } | null>(null);

  const effectiveFontSize = useMemo(
    () => Math.max(8, Math.min(40, settings.fontSize + zoomOffset)),
    [settings.fontSize, zoomOffset],
  );

  // All editor-scoped shortcuts in a single listener. One attachment =
  // no risk of duplicate registrations when deps change. Ref-based
  // accessors read the freshest activeFile so the Ctrl+L dispatch can
  // never stamp a stale path onto the event.
  const activeFileRef = useRef(activeFile);
  useEffect(() => {
    activeFileRef.current = activeFile;
  }, [activeFile]);
  const openFilesRef = useRef(openFiles);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;

      // Zoom shortcuts (without Shift).
      if (!e.shiftKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setZoomOffset((z) => Math.min(z + 1, 20));
        return;
      }
      if (!e.shiftKey && e.key === '-') {
        e.preventDefault();
        setZoomOffset((z) => Math.max(z - 1, -6));
        return;
      }
      if (!e.shiftKey && e.key === '0') {
        e.preventDefault();
        setZoomOffset(0);
        return;
      }

      // Tab navigation — handled BEFORE the shift early-return so
      // Ctrl+Shift+Tab (reverse cycle) works. PageDown/PageUp mirrors
      // VSCode's alternate binding.
      if (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') {
        const tabs = openFilesRef.current;
        if (tabs.length < 2) return;
        e.preventDefault();
        const cur = tabs.findIndex((f) => f.path === activeFileRef.current?.path);
        const reverse = (e.key === 'Tab' && e.shiftKey) || e.key === 'PageUp';
        const dir = reverse ? -1 : 1;
        const base = cur < 0 ? 0 : cur;
        const next = tabs[(base + dir + tabs.length) % tabs.length];
        if (next) setActive(next.path);
        return;
      }

      if (e.shiftKey) return;
      const k = e.key.toLowerCase();

      // Ctrl/Cmd+W — close active tab.
      if (k === 'w') {
        if (!activeFileRef.current) return;
        e.preventDefault();
        closeFile(activeFileRef.current.path);
        return;
      }

      // Ctrl/Cmd+1..9 — jump to tab N (9 = last, VSCode behaviour).
      if (k >= '1' && k <= '9') {
        const tabs = openFilesRef.current;
        if (tabs.length === 0) return;
        e.preventDefault();
        const n = Number(k);
        const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (target) setActive(target.path);
        return;
      }

      if (k === 's') {
        // Universal save shortcut. Works on every file in the editor —
        // dirty or not — so the user has a one-handed way to flush
        // changes to disk. Untitled files trigger Save As via
        // saveActiveFile's internal fallback.
        // v0.13.16 (audit #1): single authority for Cmd/Ctrl+S — the
        // duplicate handler in IDELayout's WorkspaceHotkeys was removed.
        if (!activeFileRef.current) return;
        e.preventDefault();
        saveActiveFile()
          .then((res) => {
            const name = activeFileRef.current?.name;
            if (res === 'saved') toast.success('Saved', name);
            else if (res === 'error') toast.error('Save failed', name);
            else if (res === 'cancelled') {
              /* user dismissed Save-As dialog — silent */
            } else if (res === 'unchanged') {
              /* nothing to write — silent */
            }
          })
          .catch((err) => toast.error('Save failed', (err as Error).message));
        return;
      }

      if (k === 'n') {
        e.preventDefault();
        newUntitled();
        return;
      }

      if (k === 'k') {
        const ed = editorRef.current;
        const host = containerRef.current;
        if (!ed || !host) return;
        e.preventDefault();
        const sel = ed.getSelection();
        const model = ed.getModel();
        if (!sel || !model) return;
        let text = model.getValueInRange(sel);
        let anchorLine = sel.startLineNumber;
        if (!text) {
          anchorLine = sel.positionLineNumber;
          text = model.getLineContent(anchorLine);
        }
        const editorDom = ed.getDomNode();
        if (!editorDom) return;
        const editorRect = editorDom.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const rawLineTop = ed.getTopForLineNumber(anchorLine);
        const lineTop = Number.isFinite(rawLineTop) ? rawLineTop : 0;
        const scrollTop = ed.getScrollTop();
        const layoutInfo = ed.getLayoutInfo();
        const top = editorRect.top - hostRect.top + (lineTop - scrollTop) + 24;
        const clampedTop = Math.max(
          8,
          Math.min(top, hostRect.height - 120),
        );
        const left = editorRect.left - hostRect.left + layoutInfo.contentLeft + 8;
        const width = Math.min(
          640,
          Math.max(380, layoutInfo.contentWidth - 16),
        );
        setInlineEdit({ top: clampedTop, left, width, text });
        return;
      }

      if (k === 'l') {
        const ed = editorRef.current;
        if (!ed) return;
        const sel = ed.getSelection();
        const model = ed.getModel();
        if (!sel || !model) return;
        const text = model.getValueInRange(sel);
        if (!text || text.trim().length === 0) return;
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent<{ path?: string; text: string }>('suxai:add-to-chat', {
            detail: { path: activeFileRef.current?.path, text },
          }),
        );
        toast.info('Added to chat', `${text.length} chars`);
        return;
      }
    };
    // Capture phase: intercept before Monaco's internal command
    // dispatcher claims the keystroke (Monaco listens at the editor
    // DOM in bubble phase). Without this, Cmd-S / Ctrl-S would
    // sometimes still be eaten by Monaco even though we preventDefault.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [newUntitled, saveActiveFile, setActive, closeFile, toast]);

  const onMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      setTrackedEditor(editor);

      // Dispose this editor's TextModel when the host React component
      // unmounts. Without this, Monaco keeps every TextModel ever
      // created in its global registry — opening/closing 200 tabs in
      // a session leaks 200 backing buffers (each up to MAX_FILE_BYTES).
      editor.onDidDispose(() => {
        const m = editor.getModel();
        try { m?.dispose(); } catch { /* already disposed */ }
      });

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

      // Cmd+S inside Monaco is unbound by default but some bundles
      // claim it for "format". We register a no-op so Monaco never
      // intercepts it — our window-level handler does the actual save.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        /* save handled by EditorPanel's window keydown listener */
      });

      // Ctrl+K is Monaco's chord leader for "delete line" etc. Override it
      // so our inline AI edit gets the keystroke cleanly. Dispatches the
      // same Monaco keyboard event our global listener handles.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            metaKey: true,
            bubbles: true,
          }),
        );
      });

      editor.onDidChangeCursorSelection((e) => {
        const model = editor.getModel();
        if (!model) return;
        const text = model.getValueInRange(e.selection);
        setSelection(text);
        window.dispatchEvent(
          new CustomEvent('suxai:cursor', {
            detail: {
              line: e.selection.positionLineNumber,
              column: e.selection.positionColumn,
              selection: text.length,
            },
          }),
        );

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

  // v0.13.13 — consume any pending "jump to line" stamped by a
  // cross-component navigator (SearchInFiles for now). Triggered on
  // every active-file change since the <Editor key={path}> remounts
  // and editorRef may briefly be null during the transition. We
  // retry on rAF a few frames until Monaco is mounted, then bail.
  useEffect(() => {
    if (!activeFile) return;
    const pending = consumePendingReveal(activeFile.path);
    if (!pending) return;
    let tries = 0;
    let cancelled = false;
    const tryReveal = () => {
      if (cancelled) return;
      const ed = editorRef.current;
      if (ed) {
        try {
          ed.setPosition({ lineNumber: pending.line, column: pending.column ?? 1 });
          ed.revealLineInCenter(pending.line);
          ed.focus();
        } catch { /* bad line number — swallow */ }
        return;
      }
      if (tries++ < 12) requestAnimationFrame(tryReveal);
    };
    tryReveal();
    return () => { cancelled = true; };
  }, [activeFile]);

  return (
    <section className="editor">
      <div className="editor__tabs" role="tablist">
        {openFiles.length === 0 && <div className="editor__empty-tab">No files open</div>}
        {openFiles.map((f) => (
          <div
            key={f.path}
            role="tab"
            aria-selected={f.path === activePath}
            className={`editor__tab ${f.path === activePath ? 'editor__tab--active' : ''} ${
              f.pinned ? 'editor__tab--pinned' : ''
            } ${dragPath === f.path ? 'editor__tab--dragging' : ''}`}
            onClick={() => setActive(f.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabMenu({ x: e.clientX, y: e.clientY, path: f.path });
            }}
            title={f.path}
            draggable
            onDragStart={() => setDragPath(f.path)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragPath && dragPath !== f.path) reorderTab(dragPath, f.path);
              setDragPath(null);
            }}
            onDragEnd={() => setDragPath(null)}
          >
            {f.pinned && (
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                aria-hidden
                className="editor__tab-pin"
              >
                <path
                  d="M5 1v4l2 2H3l2-2V1z"
                  stroke="currentColor"
                  strokeWidth="1"
                  fill="currentColor"
                  fillOpacity="0.4"
                />
              </svg>
            )}
            <span className="editor__tab-name">
              {f.name}
              {f.dirty ? ' •' : ''}
            </span>
            <button
              className="editor__tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeFile(f.path);
              }}
              aria-label={`Close ${f.name}`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <Breadcrumbs />

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          items={buildTabMenu(
            tabMenu.path,
            openFiles,
            {
              closeFile,
              closeOthers,
              closeToTheRight,
              closeAll,
              togglePin,
              setActive,
            },
          )}
        />
      )}

      {zoomOffset !== 0 && (
        <div className="editor__zoom-hint">
          Zoom {zoomOffset > 0 ? '+' : ''}{zoomOffset} · Ctrl+0 to reset
        </div>
      )}

      <div className="editor__body" ref={containerRef}>
        {/* v0.12.13 — only overlay InlineDiff on the tab whose path
            matches the pending diff. Without the path guard, every tab
            re-rendered the diff editor on top of itself — switching
            tabs while a diff was pending showed 3WGhlw2.lua content
            on top of, e.g., 17-OCT.txt. The diff stays in the queue
            and reappears when the user clicks back to its file. */}
        {pendingDiff && activeFile?.path === pendingDiff.path && (
          <InlineDiff diff={pendingDiff} />
        )}
        {inlineEdit && activeFile && !pendingDiff && (
          <InlineEdit
            top={inlineEdit.top}
            left={inlineEdit.left}
            width={inlineEdit.width}
            selectedText={inlineEdit.text}
            file={activeFile}
            onClose={() => setInlineEdit(null)}
          />
        )}
        {actionBar && !pendingDiff && !inlineEdit && (
          <div
            className="editor__actions"
            style={{ top: actionBar.top, left: actionBar.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              onClick={() => {
                // Fire the same keystroke the hotkey listens to so the
                // inline-edit overlay opens at the right anchor.
                window.dispatchEvent(
                  new KeyboardEvent('keydown', {
                    key: 'k',
                    ctrlKey: true,
                    metaKey: true,
                    bubbles: true,
                  }),
                );
              }}
              title="Edit selection with AI (Ctrl+K)"
              className="editor__actions-primary"
            >
              ✨ Edit
            </button>
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
              fontSize: effectiveFontSize,
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
              // Tab autocomplete (ghost text). Even when the toggle
              // is off in settings, leaving this enabled is fine —
              // the provider returns no items, so no ghost text shows.
              inlineSuggest: {
                enabled: true,
                mode: 'subwordSmart',
                showToolbar: 'onHover',
              },
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
  const { setWorkspaceRoot, newUntitled, workspaceRoot, openFile } = useWorkspace();
  const recent = useRecent();
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const Mod = isMac ? '⌘' : 'Ctrl';
  const Shift = isMac ? '⇧' : 'Shift';

  const onOpenFolder = async () => {
    try {
      const root = await window.suxai.fs.openFolder();
      if (root) setWorkspaceRoot(root);
    } catch { /* user cancelled */ }
  };

  const onOpenRecent = async (path: string, name: string) => {
    try {
      const file = await window.suxai.fs.readFile(path);
      openFile({ path: file.path, name, content: file.content });
    } catch (err) {
      // v0.13.16 (audit #10): drop the recent entry only when the file
      // is genuinely missing — keep it on transient errors so the user
      // doesn't lose their list to a one-off read failure.
      removeRecentIfMissing(path, err);
    }
  };

  // Scope recent to current workspace if one is open, else show all.
  const eligibleRecent = (
    workspaceRoot
      ? recent.filter((r) => !r.workspace || r.workspace === workspaceRoot)
      : recent
  ).slice(0, 6);

  return (
    <div className="editor__welcome">
      <div className="editor__welcome-card">
        <div className="editor__welcome-brand">SUXAI</div>
        <h2>Start coding with an AI pair</h2>
        <p>
          {workspaceRoot
            ? 'Open a file from the sidebar — or drop one anywhere — to get started.'
            : 'Open a folder, create a new file, or drop a file anywhere in this window.'}
        </p>
        <div className="editor__welcome-actions">
          <button type="button" className="editor__welcome-btn" onClick={onOpenFolder}>
            Open folder
          </button>
          <button type="button" className="editor__welcome-btn" onClick={newUntitled}>
            New file
            <kbd>{Mod}+N</kbd>
          </button>
        </div>
        {eligibleRecent.length > 0 && (
          <div className="editor__welcome-recent">
            <h3>Recent</h3>
            <ul>
              {eligibleRecent.map((r) => {
                const dir = (() => {
                  if (workspaceRoot && r.path.startsWith(workspaceRoot)) {
                    const rel = r.path
                      .slice(workspaceRoot.length)
                      .replace(/^[\\/]+/, '');
                    const parts = rel.split(/[\\/]/);
                    parts.pop();
                    return parts.join('/');
                  }
                  const parts = r.path.split(/[\\/]/);
                  parts.pop();
                  return parts.join('/');
                })();
                return (
                  <li key={r.path}>
                    <button
                      type="button"
                      className="editor__welcome-recent-item"
                      onClick={() => onOpenRecent(r.path, r.name)}
                      title={r.path}
                    >
                      <span className="editor__welcome-recent-name">{r.name}</span>
                      {dir && <span className="editor__welcome-recent-dir">{dir}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="editor__welcome-grid">
          <div className="editor__welcome-col">
            <h3>Navigation</h3>
            <ul>
              <li><kbd>{Mod}+P</kbd><span>Quick open file</span></li>
              <li><kbd>{Mod}+{Shift}+F</kbd><span>Search in files</span></li>
              <li><kbd>{Mod}+{Shift}+P</kbd><span>Command palette</span></li>
              <li><kbd>{Mod}+Tab</kbd><span>Cycle tabs</span></li>
              <li><kbd>{Mod}+1..9</kbd><span>Jump to tab</span></li>
              <li><kbd>{Mod}+W</kbd><span>Close tab</span></li>
            </ul>
          </div>
          <div className="editor__welcome-col">
            <h3>Edit & AI</h3>
            <ul>
              <li><kbd>{Mod}+S</kbd><span>Save file</span></li>
              <li><kbd>{Mod}+K</kbd><span>Inline edit (selection)</span></li>
              <li><kbd>{Mod}+L</kbd><span>Add selection to chat</span></li>
              <li><kbd>{Mod}+,</kbd><span>Settings</span></li>
              <li><kbd>{Mod}+= / -</kbd><span>Zoom editor</span></li>
            </ul>
          </div>
          <div className="editor__welcome-col">
            <h3>Panels</h3>
            <ul>
              <li><kbd>{Mod}+B</kbd><span>Toggle sidebar</span></li>
              <li><kbd>{Mod}+E</kbd><span>Toggle AI panel</span></li>
              <li><kbd>{Mod}+J</kbd> / <kbd>{Mod}+`</kbd><span>Toggle terminal</span></li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

interface TabMenuActions {
  closeFile: (p: string) => void;
  closeOthers: (p: string) => void;
  closeToTheRight: (p: string) => void;
  closeAll: () => void;
  togglePin: (p: string) => void;
  setActive: (p: string) => void;
}

function buildTabMenu(
  path: string,
  openFiles: import('../../contexts/WorkspaceContext').OpenFile[],
  actions: TabMenuActions,
): (MenuItem | 'separator')[] {
  const file = openFiles.find((f) => f.path === path);
  const tabIndex = openFiles.findIndex((f) => f.path === path);
  const hasRight = tabIndex >= 0 && tabIndex < openFiles.length - 1;
  return [
    {
      label: file?.pinned ? 'Unpin tab' : 'Pin tab',
      onClick: () => actions.togglePin(path),
    },
    'separator',
    {
      label: 'Close',
      hint: 'Ctrl+W',
      onClick: () => actions.closeFile(path),
    },
    {
      label: 'Close others',
      disabled: openFiles.filter((f) => !f.pinned || f.path === path).length <= 1,
      onClick: () => actions.closeOthers(path),
    },
    {
      label: 'Close to the right',
      disabled: !hasRight,
      onClick: () => actions.closeToTheRight(path),
    },
    {
      label: 'Close all',
      disabled: openFiles.length === 0,
      danger: true,
      onClick: () => actions.closeAll(),
    },
    'separator',
    {
      label: 'Copy path',
      disabled: path.startsWith('untitled://'),
      onClick: () => navigator.clipboard?.writeText(path),
    },
    {
      label: 'Reveal in file explorer',
      disabled: path.startsWith('untitled://'),
      onClick: () => window.suxai.fs.revealInFolder?.(path),
    },
  ];
}
