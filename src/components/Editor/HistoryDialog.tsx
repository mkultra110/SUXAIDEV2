import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listHistory,
  readSnapshot,
  formatSnapshotTs,
  type HistorySnapshot,
} from '../../lib/history';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import './HistoryDialog.css';

/**
 * v0.16.7 — File local history browse modal.
 *
 * Triggered by right-click → "Show local history" on a tab. Lists all
 * snapshots for the file (most-recent first) with timestamp + size.
 * Click a row → opens that snapshot as a read-only buffer in a new
 * tab named `<filename> @ <timestamp>` so the user can copy from it
 * without overwriting the live file. The modal closes after open.
 *
 * Two safety choices (anti-footgun) :
 *   - Snapshots open as separate buffers, never auto-restore over
 *     the current file. The user has to copy/paste manually if they
 *     want partial recovery.
 *   - Buffer paths use the synthetic `history://<sha8>/<id>` scheme
 *     so saveActiveFile won't overwrite the live file by mistake
 *     (sanitizeFsPath rejects anything not absolute on disk).
 */

interface Props {
  /** Absolute path of the file whose history to show, or null to close. */
  path: string | null;
  onClose: () => void;
}

export function HistoryDialog({ path, onClose }: Props) {
  const { openFile } = useWorkspace();
  const [snapshots, setSnapshots] = useState<HistorySnapshot[]>([]);
  const [sha8, setSha8] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setSnapshots([]);
      setSha8('');
      setErrorMsg(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    listHistory(path)
      .then((res) => {
        if (cancelled) return;
        setSnapshots(res.snapshots);
        setSha8(res.sha8);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMsg((err as Error).message ?? 'Failed to load history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path]);

  // Esc to close — captured at window level so it beats the editor.
  useEffect(() => {
    if (!path) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [path, onClose]);

  if (!path) return null;
  const fileName = path.split(/[\\/]/).pop() ?? path;

  const onOpenSnapshot = async (snap: HistorySnapshot) => {
    const content = await readSnapshot(sha8, snap.id);
    if (!content && content !== '') {
      setErrorMsg('Could not read snapshot.');
      return;
    }
    // Synthetic path : history://<sha8>/<id> — sanitizeFsPath would
    // reject this so saveActiveFile cannot accidentally overwrite the
    // original file. The buffer reads as a normal untitled-style tab
    // for copying purposes.
    const synthPath = `history://${sha8}/${snap.id}`;
    const tabName = `${fileName} @ ${formatSnapshotTs(snap.ts)}`;
    openFile({
      path: synthPath,
      name: tabName,
      content,
    });
    onClose();
  };

  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  };

  return createPortal(
    <div className="hist__overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="hist glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="hist__head">
          <div className="hist__title">
            <span className="hist__title-icon" aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
                <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </span>
            Local history
          </div>
          <div className="hist__file" title={path}>{fileName}</div>
          <button
            type="button"
            className="hist__close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="hist__list">
          {loading ? (
            <div className="hist__empty">Loading…</div>
          ) : errorMsg ? (
            <div className="hist__empty hist__empty--error">{errorMsg}</div>
          ) : snapshots.length === 0 ? (
            <div className="hist__empty">
              No snapshots yet — they're created automatically each time you save this file.
            </div>
          ) : (
            <ul className="hist__rows">
              {snapshots.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="hist__row"
                    onClick={() => void onOpenSnapshot(s)}
                  >
                    <span className="hist__row-ts">{formatSnapshotTs(s.ts)}</span>
                    <span className="hist__row-size">{formatBytes(s.sizeBytes)}</span>
                    <span className="hist__row-act">Open ↗</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="hist__foot">
          Snapshots open as read-only tabs — copy what you need, the live file stays untouched.
        </div>
      </div>
    </div>,
    document.body,
  );
}
