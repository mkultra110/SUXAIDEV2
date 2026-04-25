import { useEffect, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useToast } from '../ui/Toast';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { WindowState } from './WindowState';
import { Sidebar } from '../Sidebar/Sidebar';
import { EditorPanel } from '../Editor/EditorPanel';
import { AIPanel } from '../AI/AIPanel';
import { TerminalPanel } from '../Terminal/TerminalPanel';
import './IDELayout.css';

function WorkspaceHotkeys() {
  const {
    openFile,
    setWorkspaceRoot,
    saveActiveFile,
    reloadActiveFromDisk,
    activeFile,
  } = useWorkspace();
  const toast = useToast();

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      // Open every dropped file, not just the first.
      const files = Array.from(e.dataTransfer?.files ?? []);
      for (const file of files) {
        const anyFile = file as unknown as { path?: string };
        if (!anyFile.path) continue;
        try {
          const result = await window.suxai.fs.readFile(anyFile.path);
          const name = anyFile.path.split(/[\\/]/).pop() ?? anyFile.path;
          openFile({ path: result.path, name, content: result.content });
        } catch (err) {
          console.error('Failed to open dropped file:', err);
          toast.error('Cannot open file', (err as Error).message);
        }
      }
      // Adopt the first dropped file's parent as the workspace root if
      // we don't have one.
      const first = files.find((f) => (f as unknown as { path?: string }).path) as
        | (File & { path: string })
        | undefined;
      if (first?.path) {
        const parent = first.path.replace(/[\\/][^\\/]+$/, '');
        if (parent) setWorkspaceRoot(parent);
      }
    };
    const onKeyDown = async (e: KeyboardEvent) => {
      // Ctrl+S on Windows/Linux, Cmd+S on macOS
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!activeFile) return;
        const outcome = await saveActiveFile();
        switch (outcome) {
          case 'saved':
            toast.success('Saved', activeFile.name);
            break;
          case 'error':
            toast.error('Save failed', activeFile.name);
            break;
          case 'cancelled':
            // User dismissed the Save-As dialog — silent, no toast.
            break;
          case 'unchanged':
            // Nothing to write; no toast either.
            break;
        }
      }
    };
    // When the user comes back to the window after editing the file in
    // another app, refresh the active buffer from disk (only if it has
    // no unsaved changes locally — never overwrite the user's edits).
    const onFocus = () => {
      void reloadActiveFromDisk().then((reloaded) => {
        if (reloaded && activeFile) {
          toast.info('Reloaded from disk', activeFile.name);
        }
      });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('focus', onFocus);
    };
  }, [openFile, setWorkspaceRoot, saveActiveFile, reloadActiveFromDisk, activeFile, toast]);

  return null;
}

function TerminalHotkey({ onToggle }: { onToggle: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onToggle]);
  return null;
}

export function IDELayout() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  return (
    <div className="ide">
      <WorkspaceHotkeys />
      <WindowState />
      <TerminalHotkey onToggle={() => setTerminalOpen((o) => !o)} />
      <TitleBar />
      <div className="ide__body">
        <Sidebar />
        <EditorPanel />
        <AIPanel />
      </div>
      <TerminalPanel open={terminalOpen} onToggle={() => setTerminalOpen((o) => !o)} />
      <StatusBar onToggleTerminal={() => setTerminalOpen((o) => !o)} terminalOpen={terminalOpen} />
    </div>
  );
}
