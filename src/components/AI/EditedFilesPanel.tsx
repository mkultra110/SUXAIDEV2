import { useCallback, useMemo, useState } from 'react';
import type { ChatMessage } from './Message';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  extractEditedFiles,
  totalStats,
  type EditedFileSummary,
} from '../../lib/edited-files';
import { useToast } from '../ui/Toast';
import './EditedFilesPanel.css';

/**
 * Cursor-style "Files Modified · N" panel rendered under an assistant
 * turn that performed edits. Lists each touched file with a chip showing
 * +added/-removed line counts and the per-file status, plus master
 * Accept all / Reject all buttons and a footer "Edited files X/Y"
 * navigation. Clicking a chip opens the file in the editor and reveals
 * the first hunk.
 *
 * Stays passive when the message has no edit calls (returns null).
 *
 * Click semantics:
 *   - chip click  → switch to this file in the editor
 *   - Accept all  → re-open every still-pending diff and let the user
 *     accept hunks one by one (we don't auto-accept silently — would
 *     be too aggressive). For files that already have a pendingDiff
 *     open right now, this is a no-op nudge.
 *   - Reject all  → cancels the active diff if it belongs to one of
 *     these files; pending tool_results stay marked rejected for the
 *     model's next turn.
 */
interface Props {
  message: ChatMessage;
}

export function EditedFilesPanel({ message }: Props) {
  const files = useMemo(() => extractEditedFiles(message.toolCalls), [message.toolCalls]);
  const stats = useMemo(() => totalStats(files), [files]);
  const { openFile, setActive, openFiles, rejectPendingDiffs, acceptPendingDiffs } = useWorkspace();
  const toast = useToast();
  const [activeIdx, setActiveIdx] = useState(0);
  const [busyAccept, setBusyAccept] = useState(false);

  const goTo = useCallback(
    async (idx: number) => {
      if (idx < 0 || idx >= files.length) return;
      setActiveIdx(idx);
      const target = files[idx];
      // Open the file if it's not already in the tab strip.
      const already = openFiles.find((f) => f.path === target.path);
      if (!already) {
        try {
          const r = await window.suxai.fs.readFile(target.path);
          openFile({
            path: r.path,
            name: r.path.split(/[\\/]/).pop() ?? r.path,
            content: r.content,
          });
        } catch (err) {
          toast.error('Could not open file', (err as Error).message);
          return;
        }
      } else {
        setActive(target.path);
      }
    },
    [files, openFile, openFiles, setActive, toast],
  );

  const onRejectAll = useCallback(() => {
    // v0.12.10: bulk-reject every diff (active + queue) whose path
    // belongs to this message. Without this, parallel edit_file calls
    // queued behind the active one stayed in 'pending' forever even
    // after the user clicked Reject all — their onResolve was never
    // fired and the tool_use snapshots showed 'queued' indefinitely.
    const targets = new Set(files.map((f) => f.path));
    rejectPendingDiffs((d) => targets.has(d.path));
    toast.info('All pending edits rejected');
  }, [files, rejectPendingDiffs, toast]);

  // v4.2.3 — bulk-accept tous les pending diffs de ce message en un
  // clic. Avant : « Accept Changes » ne faisait que goTo() (ouvrir le
  // fichier) ; le user devait ensuite re-cliquer Accept dans
  // l'overlay InlineDiff. Avec 5 edit_file en queue ça faisait 5
  // clicks. Maintenant un seul click écrit tous les fichiers et
  // résout toutes les promesses du loop agent.
  const onAcceptAll = useCallback(async () => {
    if (busyAccept) return;
    const targets = new Set(files.map((f) => f.path));
    setBusyAccept(true);
    try {
      const res = await acceptPendingDiffs((d) => targets.has(d.path));
      if (res.accepted > 0) {
        toast.success(
          'Changes applied',
          `${res.accepted} file${res.accepted > 1 ? 's' : ''} written to disk` +
            (res.failed.length > 0 ? ` (${res.failed.length} failed)` : ''),
        );
      }
      for (const f of res.failed) {
        toast.error(`Could not write ${f.path.split(/[\\/]/).pop()}`, f.error);
      }
    } finally {
      setBusyAccept(false);
    }
  }, [busyAccept, files, acceptPendingDiffs, toast]);

  if (files.length === 0) return null;

  return (
    <div className="edfiles">
      <div className="edfiles__head">
        <span className="edfiles__badge">Files Modified</span>
        <span className="edfiles__count">{stats.total}</span>
        <span className="edfiles__totals">
          <span className="edfiles__plus">+{stats.added}</span>
          <span className="edfiles__minus">−{stats.removed}</span>
        </span>
        <div className="edfiles__head-spacer" />
        {stats.pending > 0 && (
          <span className="edfiles__pending-pill">{stats.pending} pending</span>
        )}
      </div>

      <div className="edfiles__list" role="list">
        {files.map((f, i) => (
          <FileChip
            key={f.path + ':' + i}
            file={f}
            isActive={i === activeIdx}
            onClick={() => void goTo(i)}
          />
        ))}
      </div>

      <div className="edfiles__foot">
        <div className="edfiles__nav">
          <button
            type="button"
            className="edfiles__nav-btn"
            onClick={() => void goTo(activeIdx - 1)}
            disabled={files.length < 2 || activeIdx === 0}
            title="Previous file"
            aria-label="Previous edited file"
          >
            ←
          </button>
          <span className="edfiles__nav-label">
            Edited files {Math.min(activeIdx + 1, files.length)}/{files.length}
          </span>
          <button
            type="button"
            className="edfiles__nav-btn"
            onClick={() => void goTo(activeIdx + 1)}
            disabled={files.length < 2 || activeIdx === files.length - 1}
            title="Next file"
            aria-label="Next edited file"
          >
            →
          </button>
        </div>
        <div className="edfiles__masters">
          <button
            type="button"
            className="edfiles__master edfiles__master--reject"
            onClick={onRejectAll}
            disabled={stats.pending === 0}
          >
            Reject all
          </button>
          <button
            type="button"
            className="edfiles__master edfiles__master--accept"
            onClick={() => void onAcceptAll()}
            disabled={stats.pending === 0 || busyAccept}
            title="Apply every pending edit to disk"
          >
            {busyAccept ? 'Applying…' : <>Accept all <kbd>Ctrl+↵</kbd></>}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileChip({
  file,
  isActive,
  onClick,
}: {
  file: EditedFileSummary;
  isActive: boolean;
  onClick: () => void;
}) {
  const name = file.path.split(/[\\/]/).pop() ?? file.path;
  return (
    <button
      type="button"
      className={
        'edfiles__chip ' +
        `edfiles__chip--${file.status}` +
        (isActive ? ' edfiles__chip--current' : '')
      }
      onClick={onClick}
      title={file.path}
      role="listitem"
    >
      <span className="edfiles__chip-icon" aria-hidden>
        {file.status === 'streaming' ? '⏳' :
         file.status === 'rejected' ? '✕' :
         file.status === 'error'    ? '⚠' :
         file.status === 'accepted' ? '✓' : '●'}
      </span>
      <span className="edfiles__chip-name">{name}</span>
      <span className="edfiles__chip-stats">
        <span className="edfiles__plus">+{file.added}</span>
        <span className="edfiles__minus">−{file.removed}</span>
      </span>
      {file.hunkCount > 1 && (
        <span className="edfiles__chip-hunks">{file.hunkCount} hunks</span>
      )}
    </button>
  );
}
