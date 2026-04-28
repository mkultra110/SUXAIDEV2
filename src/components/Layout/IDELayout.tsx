import { useEffect, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useGitStatus } from '../../lib/git';
import { applyWorkspaceSettings } from '../../lib/workspace-settings';
import { useToast } from '../ui/Toast';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { WindowState } from './WindowState';
import { ActivityBar, type SidebarView } from './ActivityBar';
import { Sidebar } from '../Sidebar/Sidebar';
import { EditorPanel } from '../Editor/EditorPanel';
import { AIPanel } from '../AI/AIPanel';
import { TerminalPanel } from '../Terminal/TerminalPanel';
import { ProblemsPanel } from '../ProblemsPanel/ProblemsPanel';
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

// v0.15.9 — persist layout preferences in localStorage so the user
// keeps their last view + open/closed state across reloads. Falls
// back to defaults if the key is missing or malformed.
const LAYOUT_KEY = 'suxai.layout.v1';

interface PersistedLayout {
  sidebarOpen: boolean;
  aiOpen: boolean;
  sidebarView: SidebarView;
}

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { sidebarOpen: true, aiOpen: true, sidebarView: 'files' };
    const parsed = JSON.parse(raw) as Partial<PersistedLayout>;
    return {
      sidebarOpen: typeof parsed.sidebarOpen === 'boolean' ? parsed.sidebarOpen : true,
      aiOpen: typeof parsed.aiOpen === 'boolean' ? parsed.aiOpen : true,
      sidebarView:
        parsed.sidebarView === 'files' || parsed.sidebarView === 'changes'
          ? parsed.sidebarView
          : 'files',
    };
  } catch {
    return { sidebarOpen: true, aiOpen: true, sidebarView: 'files' };
  }
}

function persistLayout(layout: PersistedLayout): void {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }
  catch { /* quota / disabled — silent */ }
}

export function IDELayout() {
  const [terminalOpen, setTerminalOpen] = useState(false);
  // v2.1 — Problems panel toggle (Cmd/Ctrl+Shift+M, parité VSCode).
  // Lives next to the Terminal at the bottom of the layout.
  const [problemsOpen, setProblemsOpen] = useState(false);
  // Cmd/Ctrl+Shift+M global hotkey.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault();
        setProblemsOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const initialLayout = loadLayout();
  const [sidebarOpen, setSidebarOpen] = useState(initialLayout.sidebarOpen);
  const [aiOpen, setAiOpen] = useState(initialLayout.aiOpen);
  // v0.15.8 — sidebar view state lives here so the ActivityBar (a
  // sibling, not a parent of Sidebar) can drive it without a context.
  // v0.15.9 — initial value comes from localStorage.
  const [sidebarView, setSidebarView] = useState<SidebarView>(initialLayout.sidebarView);
  // v0.15.9 — persist whenever any of the three change.
  useEffect(() => {
    persistLayout({ sidebarOpen, aiOpen, sidebarView });
  }, [sidebarOpen, aiOpen, sidebarView]);
  const { workspaceRoot } = useWorkspace();
  const gitStatus = useGitStatus(workspaceRoot);
  const dirtyCount = Object.keys(gitStatus).length;

  // v2.2 (B6) — Re-read `<root>/.vscode/settings.json` whenever the
  // workspace root changes. Effective Settings = user localStorage +
  // these overrides ; the dialog still writes only to user-level so
  // workspace prefs cannot leak when the folder closes.
  useEffect(() => {
    void applyWorkspaceSettings(workspaceRoot);
  }, [workspaceRoot]);
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
        <ActivityBar
          view={sidebarView}
          setView={setSidebarView}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          dirtyCount={dirtyCount}
        />
        <Sidebar view={sidebarView} setView={setSidebarView} />
        <EditorPanel />
        <AIPanel />
      </div>
      <TerminalPanel open={terminalOpen} onToggle={() => setTerminalOpen((o) => !o)} />
      {problemsOpen && <ProblemsPanel height={240} onClose={() => setProblemsOpen(false)} />}
      <StatusBar
        onToggleTerminal={() => setTerminalOpen((o) => !o)}
        terminalOpen={terminalOpen}
        onToggleProblems={() => setProblemsOpen((o) => !o)}
        problemsOpen={problemsOpen}
      />
    </div>
  );
}
