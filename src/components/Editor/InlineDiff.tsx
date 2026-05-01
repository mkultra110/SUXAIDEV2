import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor, type OnMount } from '@monaco-editor/react';
import type { editor as MEditor } from 'monaco-editor';
import { diffLines } from 'diff';
import { useWorkspace, type PendingDiff } from '../../contexts/WorkspaceContext';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import './InlineDiff.css';

/**
 * Inline AI diff view — Cursor / VS Code Copilot style.
 *
 * Instead of Monaco's split DiffEditor, we render a single read-only
 * Monaco editor whose content is the union of the original + the
 * proposed text: each "hunk" keeps its removed lines (rendered red,
 * struck-through) immediately before its added lines (rendered green).
 * Decorations highlight each line; a floating widget anchored on the
 * current hunk shows Accept / Reject controls.
 *
 * Per-hunk decisions:
 *   • accept  → keep the added lines, drop the removed ones
 *   • reject  → keep the removed lines, drop the added ones
 *   • pending → not yet decided (rendered with both still visible)
 *
 * Final apply rolls the user's decisions into a clean buffer and
 * writes it to disk.
 *
 * Shortcuts (when the diff has focus):
 *   • Alt+↵          accept current hunk
 *   • Shift+Alt+⌫    reject current hunk
 *   • Alt+J / Alt+K  next / previous hunk
 *   • Ctrl/Cmd+↵     accept all (auto-accept any still-pending hunks)
 *   • Ctrl/Cmd+⌫     reject all (auto-reject any still-pending hunks)
 *   • Esc            close (= reject all)
 */

type Decision = 'pending' | 'accept' | 'reject';

interface Hunk {
  id: number;
  /** 1-based [start, end] line range of the removed lines in the view buffer. */
  delRange: [number, number] | null;
  /** 1-based [start, end] line range of the added lines in the view buffer. */
  addRange: [number, number] | null;
  /** Original text (with trailing \n preserved) of the removed segment. */
  delText: string;
  /** Proposed text (with trailing \n preserved) of the added segment. */
  addText: string;
  decision: Decision;
}

interface BuiltView {
  text: string;
  hunks: Hunk[];
  /** Lines that came from `original` and should remain unchanged. */
  contextLines: number[];
}

function trimTrailingNL(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

function lineCount(s: string): number {
  if (s.length === 0) return 0;
  const t = trimTrailingNL(s);
  if (t.length === 0) return 0;
  return t.split('\n').length;
}

function buildView(original: string, proposed: string): BuiltView {
  const changes = diffLines(original, proposed);
  const out: string[] = [];
  const hunks: Hunk[] = [];
  const contextLines: number[] = [];
  let id = 0;
  let cursorLine = 1; // 1-based current line in the view buffer

  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    if (!ch.added && !ch.removed) {
      const text = trimTrailingNL(ch.value);
      if (text.length > 0) {
        const lines = text.split('\n');
        for (let l = 0; l < lines.length; l++) {
          out.push(lines[l]);
          contextLines.push(cursorLine + l);
        }
        cursorLine += lines.length;
      }
      continue;
    }

    // Collect contiguous removed + added pair into a single hunk.
    let delText = '';
    let addText = '';
    if (ch.removed) {
      delText = ch.value;
      const next = changes[i + 1];
      if (next?.added) {
        addText = next.value;
        i++;
      }
    } else if (ch.added) {
      addText = ch.value;
    }

    const delLines = lineCount(delText);
    const addLines = lineCount(addText);

    let delRange: [number, number] | null = null;
    let addRange: [number, number] | null = null;

    if (delLines > 0) {
      const lines = trimTrailingNL(delText).split('\n');
      for (const l of lines) out.push(l);
      delRange = [cursorLine, cursorLine + delLines - 1];
      cursorLine += delLines;
    }
    if (addLines > 0) {
      const lines = trimTrailingNL(addText).split('\n');
      for (const l of lines) out.push(l);
      addRange = [cursorLine, cursorLine + addLines - 1];
      cursorLine += addLines;
    }

    hunks.push({
      id: id++,
      delRange,
      addRange,
      delText,
      addText,
      decision: 'pending',
    });
  }

  return {
    text: out.join('\n'),
    hunks,
    contextLines,
  };
}

/**
 * Roll the user's per-hunk decisions into a clean final buffer.
 * Pending hunks are treated as "auto-accept" (caller decides whether
 * to call this for accept-all vs reject-all by setting decision first).
 */
function materialize(view: BuiltView): string {
  const out: string[] = [];
  let i = 0;
  const lines = view.text.split('\n');
  const total = lines.length;

  // Build a map from line → kind (context / del-of-hunk / add-of-hunk).
  type LineKind = { kind: 'context' } | { kind: 'del'; hunkId: number } | { kind: 'add'; hunkId: number };
  const map = new Array<LineKind>(total + 1);
  for (let l = 1; l <= total; l++) map[l] = { kind: 'context' };
  for (const h of view.hunks) {
    if (h.delRange) {
      for (let l = h.delRange[0]; l <= h.delRange[1]; l++) map[l] = { kind: 'del', hunkId: h.id };
    }
    if (h.addRange) {
      for (let l = h.addRange[0]; l <= h.addRange[1]; l++) map[l] = { kind: 'add', hunkId: h.id };
    }
  }
  const decisionById = new Map<number, Decision>();
  for (const h of view.hunks) decisionById.set(h.id, h.decision);

  for (let l = 1; l <= total; l++) {
    const m = map[l];
    if (m.kind === 'context') {
      out.push(lines[l - 1]);
    } else {
      const d = decisionById.get(m.hunkId) ?? 'pending';
      if (m.kind === 'add') {
        // Keep added lines unless the user rejected this hunk.
        if (d !== 'reject') out.push(lines[l - 1]);
      } else {
        // Keep removed lines only if the user explicitly rejected.
        if (d === 'reject') out.push(lines[l - 1]);
      }
    }
    i++;
    if (i > total) break;
  }

  return out.join('\n');
}

export function InlineDiff({ diff }: { diff: PendingDiff }) {
  const { closeDiff, openFiles, openFile } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = useMemo(
    () => buildView(diff.original, diff.proposed),
    [diff.original, diff.proposed],
  );

  // Decisions live in a ref so the keybinding handlers always see the
  // latest state without retriggering the editor mount effect.
  const decisionsRef = useRef<Map<number, Decision>>(new Map());
  // Public counter used to nudge React re-renders when decisions change.
  const [, forceRerender] = useState(0);
  const bump = useCallback(() => forceRerender((n) => n + 1), []);

  useEffect(() => {
    decisionsRef.current = new Map(view.hunks.map((h) => [h.id, h.decision]));
    bump();
  }, [view, bump]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const h of view.hunks) {
      if (h.addRange) added += h.addRange[1] - h.addRange[0] + 1;
      if (h.delRange) removed += h.delRange[1] - h.delRange[0] + 1;
    }
    return { added, removed };
  }, [view]);
  const noChanges = view.hunks.length === 0;

  const language = useMemo(() => {
    const target = openFiles.find((f) => f.path === diff.path);
    return target?.language ?? 'plaintext';
  }, [diff.path, openFiles]);

  const editorRef = useRef<MEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const decorationsRef = useRef<MEditor.IEditorDecorationsCollection | null>(null);
  const [activeHunkId, setActiveHunkId] = useState<number | null>(null);
  const [widgetTop, setWidgetTop] = useState<number | null>(null);

  // Keep the currently-active hunk in sync with the user's cursor.
  // The active hunk drives both the floating widget position and the
  // "Accept current / Reject current" shortcuts.
  const computeActiveHunk = useCallback(
    (lineNumber: number): number | null => {
      for (const h of view.hunks) {
        if (h.delRange && lineNumber >= h.delRange[0] && lineNumber <= h.delRange[1]) {
          return h.id;
        }
        if (h.addRange && lineNumber >= h.addRange[0] && lineNumber <= h.addRange[1]) {
          return h.id;
        }
      }
      return null;
    },
    [view],
  );

  const refreshDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const decs: MEditor.IModelDeltaDecoration[] = [];
    for (const h of view.hunks) {
      const d = decisionsRef.current.get(h.id) ?? h.decision;
      // Removed lines: red unless the user already accepted (then they
      // visually disappear by being struck-through more aggressively).
      if (h.delRange) {
        for (let l = h.delRange[0]; l <= h.delRange[1]; l++) {
          decs.push({
            range: new monaco.Range(l, 1, l, Number.MAX_SAFE_INTEGER),
            options: {
              isWholeLine: true,
              className:
                d === 'accept'
                  ? 'indiff-line indiff-line--del indiff-line--gone'
                  : d === 'reject'
                  ? 'indiff-line indiff-line--del indiff-line--kept'
                  : 'indiff-line indiff-line--del',
              linesDecorationsClassName:
                d === 'accept'
                  ? 'indiff-gutter indiff-gutter--del indiff-gutter--gone'
                  : 'indiff-gutter indiff-gutter--del',
              marginClassName:
                d === 'accept' ? 'indiff-margin indiff-margin--gone' : 'indiff-margin',
            },
          });
        }
      }
      if (h.addRange) {
        for (let l = h.addRange[0]; l <= h.addRange[1]; l++) {
          decs.push({
            range: new monaco.Range(l, 1, l, Number.MAX_SAFE_INTEGER),
            options: {
              isWholeLine: true,
              className:
                d === 'reject'
                  ? 'indiff-line indiff-line--add indiff-line--gone'
                  : d === 'accept'
                  ? 'indiff-line indiff-line--add indiff-line--kept'
                  : 'indiff-line indiff-line--add',
              linesDecorationsClassName:
                d === 'reject'
                  ? 'indiff-gutter indiff-gutter--add indiff-gutter--gone'
                  : 'indiff-gutter indiff-gutter--add',
              marginClassName:
                d === 'reject' ? 'indiff-margin indiff-margin--gone' : 'indiff-margin',
            },
          });
        }
      }
    }
    if (!decorationsRef.current) {
      decorationsRef.current = editor.createDecorationsCollection(decs);
    } else {
      decorationsRef.current.set(decs);
    }
  }, [view]);

  const updateWidgetPosition = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (activeHunkId == null) {
      setWidgetTop(null);
      return;
    }
    const h = view.hunks.find((x) => x.id === activeHunkId);
    if (!h) {
      setWidgetTop(null);
      return;
    }
    const startLine =
      (h.delRange && h.delRange[0]) ?? (h.addRange && h.addRange[0]) ?? 1;
    const top = editor.getTopForLineNumber(startLine) - editor.getScrollTop();
    setWidgetTop(Math.max(4, top));
  }, [activeHunkId, view]);

  const onMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      editor.updateOptions({ readOnly: true });

      // Initial active hunk: the first one.
      if (view.hunks.length > 0) {
        setActiveHunkId(view.hunks[0].id);
        // Reveal it so the user sees a change immediately on open.
        const first = view.hunks[0];
        const line = (first.delRange && first.delRange[0]) ?? (first.addRange && first.addRange[0]) ?? 1;
        editor.revealLineInCenterIfOutsideViewport(line);
      }

      editor.onDidChangeCursorPosition((e) => {
        const id = computeActiveHunk(e.position.lineNumber);
        if (id != null) setActiveHunkId(id);
        // When the cursor sits on a context line, leave activeHunkId
        // as-is so the widget tracks the last-touched hunk.
      });
      editor.onDidScrollChange(() => updateWidgetPosition());

      refreshDecorations();
      // First widget-position pass after the editor lays out.
      setTimeout(updateWidgetPosition, 30);
    },
    [view, computeActiveHunk, refreshDecorations, updateWidgetPosition],
  );

  // Re-decorate whenever decisions change; reposition the widget too.
  useEffect(() => {
    refreshDecorations();
    updateWidgetPosition();
  }, [refreshDecorations, updateWidgetPosition, activeHunkId]);

  // ---- Decisions ---------------------------------------------------

  const decideHunk = useCallback(
    (hunkId: number, decision: Decision) => {
      decisionsRef.current.set(hunkId, decision);
      // Auto-advance to the next still-pending hunk.
      const idx = view.hunks.findIndex((h) => h.id === hunkId);
      let nextPending: Hunk | undefined;
      for (let i = idx + 1; i < view.hunks.length; i++) {
        if ((decisionsRef.current.get(view.hunks[i].id) ?? 'pending') === 'pending') {
          nextPending = view.hunks[i];
          break;
        }
      }
      if (nextPending) {
        setActiveHunkId(nextPending.id);
        const line =
          (nextPending.delRange && nextPending.delRange[0]) ??
          (nextPending.addRange && nextPending.addRange[0]) ??
          1;
        editorRef.current?.revealLineInCenterIfOutsideViewport(line);
      }
      bump();
    },
    [view, bump],
  );

  const goToHunk = useCallback(
    (direction: 'next' | 'prev') => {
      if (view.hunks.length === 0) return;
      const idx = view.hunks.findIndex((h) => h.id === activeHunkId);
      const cur = idx < 0 ? 0 : idx;
      const target =
        direction === 'next'
          ? view.hunks[(cur + 1) % view.hunks.length]
          : view.hunks[(cur - 1 + view.hunks.length) % view.hunks.length];
      setActiveHunkId(target.id);
      const line =
        (target.delRange && target.delRange[0]) ??
        (target.addRange && target.addRange[0]) ??
        1;
      editorRef.current?.revealLineInCenterIfOutsideViewport(line);
    },
    [view, activeHunkId],
  );

  const reject = useCallback(() => {
    if (busy) return;
    // Notify the caller (agent loop, etc.) before closing.
    diff.onResolve?.(false);
    closeDiff();
  }, [busy, closeDiff, diff]);

  const writeProposal = useCallback(
    async (finalText: string) => {
      const isUntitled = diff.path.startsWith('untitled://');
      if (!isUntitled) {
        // Stale-check: refuse if the on-disk file changed since open.
        try {
          const onDiskNow = await window.suxai.fs.readFile(diff.path);
          if (onDiskNow.content !== diff.original) {
            throw new Error(
              'File changed on disk since this diff was opened. Reject and re-run to refresh.',
            );
          }
        } catch (readErr) {
          if ((readErr as Error).message?.includes('changed on disk')) throw readErr;
          throw new Error(
            `Could not verify file before save: ${(readErr as Error).message ?? readErr}`,
          );
        }
        await window.suxai.fs.writeFile(diff.path, finalText);
      }
      const target = openFiles.find((f) => f.path === diff.path);
      if (target) {
        openFile({
          ...target,
          content: finalText,
          dirty: isUntitled,
        });
      }
    },
    [diff, openFiles, openFile],
  );

  const acceptCurrentDecisions = useCallback(async () => {
    if (busy) return;
    if (noChanges) {
      diff.onResolve?.(true, diff.original);
      closeDiff();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Roll any still-pending hunks as accepted (matches the
      // "Accept Changes" semantics of Cursor — anything not explicitly
      // rejected is taken).
      const finalView: BuiltView = {
        ...view,
        hunks: view.hunks.map((h) => {
          const d = decisionsRef.current.get(h.id) ?? h.decision;
          return { ...h, decision: d === 'pending' ? 'accept' : d };
        }),
      };
      const finalText = materialize(finalView);
      // v3.18.3 FIX — TOUJOURS appeler writeProposal (disk + buffer
      // sync), même quand onResolve est wiré. L'ancien code shippé
      // n'écrivait pas quand onResolve existait, partant du principe
      // que le caller (agent edit_file) gérait la persistance. Mais
      // requestApproval (AIPanel) répondait written=true au caller,
      // qui croyait alors que le write avait déjà eu lieu et skipait
      // son propre fs.writeFile. Résultat : « l'agent dit qu'il
      // modifie mais le fichier ne change pas ».
      // Le bon contrat : InlineDiff persiste les décisions hunk-par-
      // hunk (qu'il connaît seul, le caller a juste l'intent global),
      // puis notifie le caller via onResolve avec le finalText. Le
      // caller voit written=true et skip son write — correct
      // maintenant que InlineDiff a vraiment écrit.
      await writeProposal(finalText);
      diff.onResolve?.(true, finalText);
      closeDiff();
      toast.success('Changes applied', `+${stats.added} / −${stats.removed} lines`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      // v0.11.9: STALE_FILE is the named error main process throws
      // when the on-disk mtime moved between read and write (an
      // external editor or a CI tool touched the file). Surface a
      // friendlier message so the user understands they need to
      // either reload the file (and lose the diff) or force-write
      // (and clobber the external edit).
      const isStale = /modified externally|STALE_FILE/i.test(msg);
      const friendly = isStale
        ? `Le fichier a été modifié à l'extérieur depuis l'ouverture du diff. ` +
          `Recharge le fichier (le diff sera perdu) ou rejette ce diff puis relance la requête.`
        : msg;
      setError(friendly);
      toast.error(isStale ? 'Fichier modifié à l\'extérieur' : 'Could not save', friendly);
    } finally {
      setBusy(false);
    }
  }, [busy, noChanges, closeDiff, view, writeProposal, stats, toast, diff]);

  // ---- Keybindings -------------------------------------------------

  const acceptRef = useRef(acceptCurrentDecisions);
  acceptRef.current = acceptCurrentDecisions;
  const rejectRef = useRef(reject);
  rejectRef.current = reject;
  const decideRef = useRef(decideHunk);
  decideRef.current = decideHunk;
  const goRef = useRef(goToHunk);
  goRef.current = goToHunk;
  const activeRef = useRef(activeHunkId);
  activeRef.current = activeHunkId;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Esc — close the diff entirely.
      if (e.key === 'Escape') {
        e.preventDefault();
        rejectRef.current();
        return;
      }
      // Ctrl/Cmd+Enter — accept everything.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        void acceptRef.current();
        return;
      }
      // Alt+Enter — accept current hunk.
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'Enter') {
        e.preventDefault();
        if (activeRef.current != null) decideRef.current(activeRef.current, 'accept');
        return;
      }
      // Shift+Alt+Backspace — reject current hunk.
      if (
        e.altKey &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.key === 'Backspace' || e.key === 'Delete')
      ) {
        e.preventDefault();
        if (activeRef.current != null) decideRef.current(activeRef.current, 'reject');
        return;
      }
      // Alt+J — next hunk; Alt+K — previous hunk (Cursor convention).
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        goRef.current('next');
        return;
      }
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        goRef.current('prev');
        return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ---- Render ------------------------------------------------------

  const activeHunk = view.hunks.find((h) => h.id === activeHunkId) ?? null;
  const decidedCount = view.hunks.filter(
    (h) => (decisionsRef.current.get(h.id) ?? h.decision) !== 'pending',
  ).length;

  return (
    <div className="indiff">
      <Editor
        height="100%"
        language={language}
        value={view.text}
        theme="suxai-dark"
        onMount={onMount}
        options={{
          readOnly: true,
          fontFamily: 'JetBrains Mono, Fira Code, Menlo, monospace',
          fontSize: 13,
          fontLigatures: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          padding: { top: 14, bottom: 80 },
          automaticLayout: true,
          renderLineHighlight: 'none',
          glyphMargin: false,
          lineNumbersMinChars: 3,
        }}
      />

      {/* Floating per-hunk action chip — anchored on the active hunk. */}
      {activeHunk && widgetTop != null && (
        <div
          className="indiff__hunkbar"
          style={{ top: widgetTop }}
          onMouseDown={(e) => e.preventDefault() /* keep editor focused */}
        >
          <button
            type="button"
            className="indiff__hunkbtn indiff__hunkbtn--accept"
            onClick={() => decideHunk(activeHunk.id, 'accept')}
            title="Accept this hunk"
          >
            Accept <kbd>Alt+↵</kbd>
          </button>
          <button
            type="button"
            className="indiff__hunkbtn indiff__hunkbtn--reject"
            onClick={() => decideHunk(activeHunk.id, 'reject')}
            title="Reject this hunk"
          >
            Reject <kbd>⇧Alt+⌫</kbd>
          </button>
        </div>
      )}

      {/* Bottom command bar — Cursor-style. */}
      <div className="indiff__bar glass-strong">
        <div className="indiff__bar-left">
          <span className="indiff__badge">AI diff</span>
          <span className="indiff__file" title={diff.path}>
            {diff.path.split(/[\\/]/).pop()}
          </span>
          {diff.label && <span className="indiff__label">{diff.label}</span>}
          <span className="indiff__stats">
            <span className="indiff__plus">+{stats.added}</span>
            <span className="indiff__minus">−{stats.removed}</span>
            {noChanges && <span className="indiff__nochg">no changes</span>}
            {!noChanges && (
              <span className="indiff__progress">
                {decidedCount}/{view.hunks.length} decided
              </span>
            )}
          </span>
        </div>

        <div className="indiff__bar-right">
          <button
            type="button"
            className="indiff__navbtn"
            onClick={() => goToHunk('prev')}
            disabled={view.hunks.length < 2}
            title="Previous hunk (Alt+K)"
          >
            ↑ <kbd>Alt+K</kbd>
          </button>
          <button
            type="button"
            className="indiff__navbtn"
            onClick={() => goToHunk('next')}
            disabled={view.hunks.length < 2}
            title="Next hunk (Alt+J)"
          >
            ↓ <kbd>Alt+J</kbd>
          </button>
          <span className="indiff__sep" />
          <Button variant="ghost" size="sm" onClick={reject} disabled={busy}>
            Reject <kbd className="indiff__kbd">Ctrl+⌫</kbd>
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void acceptCurrentDecisions()}
            disabled={busy || noChanges}
            leftIcon={busy ? <Spinner size={12} /> : undefined}
          >
            {busy ? 'Saving…' : 'Accept Changes'}{' '}
            <kbd className="indiff__kbd">Ctrl+↵</kbd>
          </Button>
        </div>
      </div>

      {error && <div className="indiff__error">⚠ {error}</div>}
    </div>
  );
}
