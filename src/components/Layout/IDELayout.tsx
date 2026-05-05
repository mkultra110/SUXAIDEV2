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
import { OutputPanel } from '../OutputPanel/OutputPanel';
import { WhatsNewDialog } from '../WhatsNew/WhatsNewDialog';
import { SmsPanel } from '../SMS/SmsPanel';
import './IDELayout.css';

function WorkspaceHotkeys() {
  const {
    openFile,
    setWorkspaceRoot,
    setWorkspaceRoots,
    setWorkspaceFile,
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
      // v3.13 — special-case .code-workspace : un drop sur la fenêtre
      // charge le workspace au lieu d'ouvrir le file en éditeur. Si
      // plusieurs `.code-workspace` sont droppés, on prend le premier.
      const wsDrop = files.find((f) => {
        const p = (f as unknown as { path?: string }).path;
        return typeof p === 'string' && p.endsWith('.code-workspace');
      }) as (File & { path: string }) | undefined;
      if (wsDrop?.path) {
        try {
          const result = await window.suxai.fs.readFile(wsDrop.path);
          const { parseCodeWorkspace } = await import('../../lib/code-workspace');
          const ws = parseCodeWorkspace(result.content);
          if (!ws) {
            toast.error('Invalid .code-workspace', 'File could not be parsed.');
            return;
          }
          setWorkspaceRoots(ws.folders.map((f) => f.path));
          setWorkspaceFile(result.path);
          const name = result.path.split(/[\\/]/).pop() ?? result.path;
          toast.success(`Opened ${name}`, `${ws.folders.length} folders`);
          return;
        } catch (err) {
          console.error('Failed to open dropped workspace:', err);
          toast.error('Open Workspace failed', (err as Error).message);
          return;
        }
      }
      for (const file of files) {
        const anyFile = file as unknown as { path?: string };
        if (!anyFile.path) continue;
        try {
          const result = await window.suxai.fs.readFile(anyFile.path);
          const name = anyFile.path.split(/[\\/]/).pop() ?? anyFile.path;
          openFile({ path: result.path, name, content: result.content, eol: result.eol, encoding: result.encoding });
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
  // v3.6 — Output panel toggle (Cmd/Ctrl+Shift+U, parité VSCode A7).
  const [outputOpen, setOutputOpen] = useState(false);
  // v3.16 — Zen mode (parité VSCode Cmd+K Z). Quand on, hide
  // ActivityBar / Sidebar / AIPanel / Terminal / Problems / Output
  // pour ne laisser QUE l'éditeur. La TitleBar + StatusBar restent
  // visibles (perdre la titlebar fait disparaître les window
  // controls — gênant). Cmd+K Z pour toggle, Esc pour exit.
  const [zenMode, setZenMode] = useState(false);
  // Cmd/Ctrl+Shift+M (Problems) + Cmd/Ctrl+Shift+U (Output) global hotkeys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        e.preventDefault();
        setProblemsOpen((o) => !o);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'U' || e.key === 'u')) {
        e.preventDefault();
        setOutputOpen((o) => !o);
        return;
      }
      // v4.0 — Cmd/Ctrl+Shift+A : open Squad multi-agent audit modal.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('suxai:open-squad'));
      }
      // v5.2 — Cmd/Ctrl+Shift+N : open SMS panel (« N » comme Number).
      // Pas Shift+S parce que collide avec le « Save As » familier.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('suxai:open-sms'));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // v3.6 — listen for `suxai:open-output` (CommandPalette + status bar).
  useEffect(() => {
    const handler = () => setOutputOpen(true);
    window.addEventListener('suxai:open-output', handler);
    return () => window.removeEventListener('suxai:open-output', handler);
  }, []);

  // v3.16 — Cmd+K Z (zen mode chord) + Esc to exit. Pattern chord :
  // après un Cmd+K dans une fenêtre courte (1500 ms), un Z suivant
  // toggle zen mode. Aussi écoute `suxai:toggle-zen-mode` event pour
  // que la palette puisse trigger via une commande.
  useEffect(() => {
    let chordPending = 0;
    const onKey = (e: KeyboardEvent) => {
      if (chordPending > 0 && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        chordPending = 0;
        setZenMode((z) => !z);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K') && !e.shiftKey && !e.altKey) {
        // Cmd+K solo : start chord. Note that EditorPanel a son propre
        // Cmd+K listener pour l'inline edit ; il ne preventDefault pas
        // ici, donc le suivant reste possible. Si l'utilisateur tape
        // Cmd+K Z avec curseur dans Monaco, le K sera consommé par
        // l'inline-edit dialog — fenêtre Z se ferme à 1500 ms.
        chordPending = window.setTimeout(() => { chordPending = 0; }, 1500);
        return;
      }
      if (zenMode && e.key === 'Escape') {
        e.preventDefault();
        setZenMode(false);
      }
    };
    const onZenEvent = () => setZenMode((z) => !z);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('suxai:toggle-zen-mode', onZenEvent);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('suxai:toggle-zen-mode', onZenEvent);
    };
  }, [zenMode]);
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
  // v3.15 — Ctrl/Cmd+Shift+E (Explorer) + Ctrl/Cmd+Shift+G (Source
  // Control) parité VSCode. Bascule la sidebar view + force ouvert
  // si elle est fermée. Pas de toggle-collapse comme dans VSCode :
  // la 1re pression ouvre la view, la 2e laisse la view (pas de
  // « cacher si déjà visible » — moins surprenant, plus simple).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key === 'E' || e.key === 'e') {
        e.preventDefault();
        setSidebarView('files');
        setSidebarOpen(true);
      } else if (e.key === 'G' || e.key === 'g') {
        e.preventDefault();
        setSidebarView('changes');
        setSidebarOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const { workspaceRoot, workspaceRoots, workspaceFile } = useWorkspace();
  const gitStatus = useGitStatus(workspaceRoot);
  const dirtyCount = Object.keys(gitStatus).length;

  // v2.2 (B6) → v3.13 — re-read .vscode/settings.json from each root
  // AND the top-level `settings` block of the active .code-workspace
  // file if any. Merge order : per-root in declaration order, then
  // workspace file on top (parité VSCode : workspace file wins).
  useEffect(() => {
    void applyWorkspaceSettings(workspaceRoots, workspaceFile);
  }, [workspaceRoots, workspaceFile]);
  const bodyClass =
    'ide__body' +
    (sidebarOpen ? '' : ' ide__body--no-sidebar') +
    (aiOpen ? '' : ' ide__body--no-ai');
  return (
    <div className={`ide${zenMode ? ' ide--zen' : ''}`}>
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
      {outputOpen && <OutputPanel height={240} onClose={() => setOutputOpen(false)} />}
      <StatusBar
        onToggleTerminal={() => setTerminalOpen((o) => !o)}
        terminalOpen={terminalOpen}
        onToggleProblems={() => setProblemsOpen((o) => !o)}
        problemsOpen={problemsOpen}
        onToggleOutput={() => setOutputOpen((o) => !o)}
        outputOpen={outputOpen}
      />
      {/* v5.0 — What's new dialog. Affiché une fois par major bump
          (5.x → 6.x), ou au tout premier lancement après upgrade.
          Stamp localStorage à la fermeture pour ne pas re-spammer. */}
      <WhatsNewDialog />
      {/* v5.2 — SMS panel modal. Ouvert via Cmd+Shift+S ou la
          command palette. Reste invisible tant que l'event
          suxai:open-sms n'a pas été dispatché. */}
      <SmsPanel />
    </div>
  );
}
