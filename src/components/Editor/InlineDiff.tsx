import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { diffLines } from 'diff';
import { useWorkspace, type PendingDiff } from '../../contexts/WorkspaceContext';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import './InlineDiff.css';

interface Stats {
  added: number;
  removed: number;
}

function computeStats(original: string, proposed: string): Stats {
  const changes = diffLines(original, proposed);
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    const lines = c.value.replace(/\n$/, '').split('\n').length;
    if (c.added) added += lines;
    else if (c.removed) removed += lines;
  }
  return { added, removed };
}

/**
 * Inline AI diff view. The active file is replaced by Monaco's built-in
 * DiffEditor in inline mode (single column, green for additions, red
 * with strikethrough for removals, gutter markers). A floating overlay
 * at the bottom shows +X / -Y stats and Accept / Reject controls.
 *
 * Shortcuts:
 *   • Esc          — reject (restore original, close diff)
 *   • Ctrl/Cmd+↵   — accept (apply + write to disk)
 *
 * Safety: original content is held by WorkspaceContext.pendingDiff for
 * the lifetime of the diff and never overwritten until Accept fires
 * successfully. A failed write surfaces as a toast and leaves the diff
 * open so the user can retry.
 */
export function InlineDiff({ diff }: { diff: PendingDiff }) {
  const { closeDiff, openFiles, openFile } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stats = useMemo(
    () => computeStats(diff.original, diff.proposed),
    [diff.original, diff.proposed],
  );
  const noChanges = stats.added === 0 && stats.removed === 0;

  const language = useMemo(() => {
    const target = openFiles.find((f) => f.path === diff.path);
    return target?.language ?? 'plaintext';
  }, [diff.path, openFiles]);

  const onMount: DiffOnMount = useCallback((editor, _monaco) => {
    // Keep both panes read-only. The whole point of the diff view is to
    // make a binary Accept / Reject decision; mid-diff editing
    // invalidates the diff math.
    editor.getOriginalEditor().updateOptions({ readOnly: true });
    editor.getModifiedEditor().updateOptions({ readOnly: true });
  }, []);

  const reject = useCallback(() => {
    if (busy) return;
    closeDiff();
  }, [busy, closeDiff]);

  const acceptRef = useRef<() => Promise<void>>(async () => {});

  const accept = useCallback(async () => {
    if (busy) return;
    if (noChanges) {
      closeDiff();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Save the file to disk first — if the write fails we don't want
      // the in-memory state to claim the change is committed.
      // Untitled buffers (in-memory only) skip the disk write and just
      // get their content swapped.
      const isUntitled = diff.path.startsWith('untitled://');
      if (!isUntitled) {
        await window.suxai.fs.writeFile(diff.path, diff.proposed);
      }
      const target = openFiles.find((f) => f.path === diff.path);
      if (target) {
        openFile({
          ...target,
          content: diff.proposed,
          dirty: isUntitled, // disk is now in sync, except for untitled
        });
      }
      closeDiff();
      toast.success('Changes applied', `+${stats.added} / -${stats.removed} lines`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      toast.error('Could not save', msg);
    } finally {
      setBusy(false);
    }
  }, [busy, noChanges, closeDiff, diff, openFiles, openFile, stats, toast]);

  acceptRef.current = accept;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        reject();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void acceptRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [reject]);

  return (
    <div className="indiff">
      <DiffEditor
        height="100%"
        original={diff.original}
        modified={diff.proposed}
        language={language}
        theme="suxai-dark"
        onMount={onMount}
        options={{
          readOnly: true,
          renderSideBySide: false,
          renderOverviewRuler: false,
          fontFamily: 'JetBrains Mono, Fira Code, Menlo, monospace',
          fontSize: 13,
          fontLigatures: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          padding: { top: 14, bottom: 80 }, // leave room for the overlay
          automaticLayout: true,
          renderLineHighlight: 'none',
          enableSplitViewResizing: false,
          ignoreTrimWhitespace: false,
        }}
      />

      <div className="indiff__overlay glass-strong">
        <div className="indiff__title">
          <span className="indiff__badge">AI diff</span>
          <span className="indiff__file" title={diff.path}>
            {diff.path.split(/[\\/]/).pop()}
          </span>
          {diff.label && <span className="indiff__label">{diff.label}</span>}
          <span className="indiff__stats">
            <span className="indiff__plus">+{stats.added}</span>
            <span className="indiff__minus">−{stats.removed}</span>
            {noChanges && <span className="indiff__nochg">no changes</span>}
          </span>
        </div>

        {error && <div className="indiff__error">⚠ {error}</div>}

        <div className="indiff__actions">
          <Button variant="ghost" size="md" onClick={reject} disabled={busy}>
            Reject <kbd className="indiff__kbd">Esc</kbd>
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => void accept()}
            disabled={busy || noChanges}
            leftIcon={busy ? <Spinner size={12} /> : undefined}
          >
            {busy ? 'Saving…' : 'Accept'}{' '}
            <kbd className="indiff__kbd">⌘↵</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
