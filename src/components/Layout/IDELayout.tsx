import { useEffect } from 'react';
import { WorkspaceProvider, useWorkspace } from '../../contexts/WorkspaceContext';
import { TitleBar } from './TitleBar';
import { Sidebar } from '../Sidebar/Sidebar';
import { EditorPanel } from '../Editor/EditorPanel';
import { AIPanel } from '../AI/AIPanel';
import './IDELayout.css';

function WorkspaceHotkeys() {
  const { openFile, setWorkspaceRoot } = useWorkspace();

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
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFile, setWorkspaceRoot]);

  return null;
}

function Shell() {
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

export function IDELayout() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  );
}
