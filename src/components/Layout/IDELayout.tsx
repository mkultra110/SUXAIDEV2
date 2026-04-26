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
    // v0.13.16 (audit #1) — Cmd/Ctrl+S used to be handled here AND in
    // EditorPanel. Both fired (capture + bubble), causing a duplicate
    // saveActiveFile() round-trip. EditorPanel is now the single
    // authority for the save shortcut.
    //
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
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('focus', onFocus);
    };
  }, [openFile, setWorkspaceRoot, reloadActiveFromDisk, activeFile, toast]);

  return null;
}

function TerminalHotkey({ onToggle }: { onToggle: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+` (backtick) — primary VSCode binding.
      // Ctrl+J — secondary VSCode binding for the bottom panel.
      const isToggleKey =
        e.key === '`' ||
        (!e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j');
      if ((e.metaKey || e.ctrlKey) && isToggleKey) {
        e.preventDefault();
        onToggle();
      }
    };
    // v0.13.16 (audit #6) — capture phase so Monaco can't claim
    // Ctrl+J first if the editor has focus (Monaco doesn't bind it
    // by default, but a user setting or extension could).
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onToggle]);
  return null;
}

function PanelToggleHotkeys({
  onToggleSidebar,
  onToggleAi,
}: {
  onToggleSidebar: () => void;
  onToggleAi: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      // Cmd/Ctrl+B — toggle file sidebar (VSCode parity).
      if (k === 'b') {
        e.preventDefault();
        onToggleSidebar();
        return;
      }
      // Cmd/Ctrl+E — toggle AI panel. Picked because it has no
      // existing binding in our app and doesn't collide with
      // Monaco's defaults outside of macOS where Cmd+E is "use
      // selection for find" — but our editor-scoped handler runs
      // first in capture phase so this stays safe.
      if (k === 'e') {
        e.preventDefault();
        onToggleAi();
      }
    };
    // Capture phase so Monaco can't claim Cmd+B / Cmd+E first.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onToggleSidebar, onToggleAi]);
  return null;
}

export function IDELayout() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(true);
  const bodyClass =
    'ide__body' +
    (sidebarOpen ? '' : ' ide__body--no-sidebar') +
    (aiOpen ? '' : ' ide__body--no-ai');
  return (
    <div className="ide">
      <WorkspaceHotkeys />
      <WindowState />
      <TerminalHotkey onToggle={() => setTerminalOpen((o) => !o)} />
      <PanelToggleHotkeys
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onToggleAi={() => setAiOpen((o) => !o)}
      />
      <TitleBar />
      <div className={bodyClass}>
        <Sidebar />
        <EditorPanel />
        <AIPanel />
      </div>
      <TerminalPanel open={terminalOpen} onToggle={() => setTerminalOpen((o) => !o)} />
      <StatusBar onToggleTerminal={() => setTerminalOpen((o) => !o)} terminalOpen={terminalOpen} />
    </div>
  );
}
