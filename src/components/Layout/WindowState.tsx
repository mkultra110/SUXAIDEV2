import { useEffect } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useToast } from '../ui/Toast';

/**
 * Sync workspace state to the native window — title reflects the active
 * file, "edited" dot is toggled on macOS via setDocumentEdited, and
 * close-requests are intercepted so we can prompt before quitting with
 * unsaved changes.
 */
export function WindowState() {
  const { activeFile, hasUnsaved, openFiles } = useWorkspace();
  const toast = useToast();

  // Window title follows the active file.
  useEffect(() => {
    const base = 'SUXAI';
    const dirty = activeFile?.dirty ? '● ' : '';
    const title = activeFile ? `${dirty}${activeFile.name} — ${base}` : base;
    window.suxai.window.setTitle?.(title);
  }, [activeFile?.name, activeFile?.dirty]);

  // macOS document-edited indicator.
  useEffect(() => {
    window.suxai.window.setDirty?.(hasUnsaved);
  }, [hasUnsaved]);

  // Handle the main-process "close requested" signal.
  useEffect(() => {
    let off: (() => void) | undefined;
    const maybeOff = window.suxai.window.onCloseRequested?.(() => {
      const unsavedNames = openFiles
        .filter((f) => f.dirty && !f.untitled)
        .map((f) => f.name);
      if (unsavedNames.length === 0) {
        window.suxai.window.confirmClose?.();
        return;
      }
      const ok = window.confirm(
        `You have unsaved changes in ${unsavedNames.length} file${
          unsavedNames.length > 1 ? 's' : ''
        }:\n\n  ${unsavedNames.slice(0, 8).join('\n  ')}${
          unsavedNames.length > 8 ? `\n  …` : ''
        }\n\nQuit anyway?`,
      );
      if (ok) {
        window.suxai.window.confirmClose?.();
      } else {
        toast.info('Close cancelled', 'Save (Ctrl+S) before quitting.');
      }
    });
    // The preload's onCloseRequested returns an IpcRenderer instance in
    // some typings; wrap it so our cleanup is void-returning.
    off = typeof maybeOff === 'function' ? () => void maybeOff() : undefined;
    return () => off?.();
  }, [openFiles, toast]);

  return null;
}
