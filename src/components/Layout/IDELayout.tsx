import { useEffect } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useToast } from '../ui/Toast';
import { TitleBar } from './TitleBar';
import { Sidebar } from '../Sidebar/Sidebar';
import { EditorPanel } from '../Editor/EditorPanel';
import { AIPanel } from '../AI/AIPanel';
import './IDELayout.css';

function WorkspaceHotkeys() {
  const { openFile, setWorkspaceRoot, saveActiveFile, activeFile } = useWorkspace();
  const toast = useToast();

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const anyFile = file as unknown as { path?: string };
      if (!anyFile.path) return;
      try {
        const result = await window.suxai.fs.readFile(anyFile.path);
        const name = anyFile.path.split(/[\\/]/).pop() ?? anyFile.path;
        openFile({ path: result.path, name, content: result.content });
        const parent = anyFile.path.replace(/[\\/][^\\/]+$/, '');
        if (parent) setWorkspaceRoot(parent);
      } catch (err) {
        console.error('Failed to open dropped file:', err);
        toast.error('Cannot open file', (err as Error).message);
      }
    };
    const onKeyDown = async (e: KeyboardEvent) => {
      // Ctrl+S on Windows/Linux, Cmd+S on macOS
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!activeFile) return;
        const ok = await saveActiveFile();
        if (ok) toast.success('Saved', activeFile.name);
        else toast.error('Save failed', activeFile.name);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openFile, setWorkspaceRoot, saveActiveFile, activeFile, toast]);

  return null;
}

export function IDELayout() {
  return (
    <div className="ide">
      <WorkspaceHotkeys />
      <TitleBar />
      <div className="ide__body">
        <Sidebar />
        <EditorPanel />
        <AIPanel />
      </div>
    </div>
  );
}
