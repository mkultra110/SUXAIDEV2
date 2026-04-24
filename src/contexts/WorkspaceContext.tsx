import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty?: boolean;
  language?: string;
}

export interface PendingDiff {
  /** The file path this diff applies to. */
  path: string;
  /** Original content (usually the file's current content when diff opened). */
  original: string;
  /** Proposed content (from AI). */
  proposed: string;
  /** Short label shown in the diff toolbar (e.g. the model id or command). */
  label?: string;
}

interface WorkspaceState {
  workspaceRoot: string | null;
  openFiles: OpenFile[];
  activePath: string | null;
  selection: string;
  pendingDiff: PendingDiff | null;
}

interface WorkspaceValue extends WorkspaceState {
  setWorkspaceRoot: (root: string | null) => void;
  openFile: (file: OpenFile) => void;
  closeFile: (path: string) => void;
  setActive: (path: string) => void;
  updateActiveContent: (content: string) => void;
  setSelection: (text: string) => void;
  saveActiveFile: () => Promise<boolean>;
  openDiff: (d: PendingDiff) => void;
  closeDiff: () => void;
  acceptDiff: () => void;
  activeFile: OpenFile | null;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    // Web
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'scss',
    less: 'less', vue: 'html', svelte: 'html',
    // Data
    json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
    ini: 'ini',
    // Systems
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', go: 'go', rs: 'rust',
    // JVM
    java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'java',
    // Apple
    swift: 'swift', m: 'objective-c', mm: 'objective-c',
    // Scripting
    py: 'python', pyi: 'python', rb: 'ruby', php: 'php',
    pl: 'perl', lua: 'lua', sh: 'shell', bash: 'shell', zsh: 'shell',
    fish: 'shell', ps1: 'powershell',
    // Functional
    hs: 'haskell', clj: 'clojure', cljs: 'clojure', ex: 'elixir', exs: 'elixir',
    // Mobile
    dart: 'dart',
    // DB / query
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    // DevOps
    dockerfile: 'dockerfile', tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
    // Data science
    r: 'r', jl: 'julia',
  };

  // Filename-based fallbacks (no extension or special names).
  const name = p.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';

  return map[ext] ?? 'plaintext';
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>({
    workspaceRoot: null,
    openFiles: [],
    activePath: null,
    selection: '',
    pendingDiff: null,
  });

  const setWorkspaceRoot = useCallback((root: string | null) => {
    setState((s) => ({ ...s, workspaceRoot: root }));
  }, []);

  const openFile = useCallback((file: OpenFile) => {
    setState((s) => {
      const language = file.language ?? langFromPath(file.path);
      const existingIdx = s.openFiles.findIndex((f) => f.path === file.path);
      const next = [...s.openFiles];
      if (existingIdx >= 0) next[existingIdx] = { ...next[existingIdx], ...file, language };
      else next.push({ ...file, language });
      return { ...s, openFiles: next, activePath: file.path };
    });
  }, []);

  const closeFile = useCallback((path: string) => {
    setState((s) => {
      const filtered = s.openFiles.filter((f) => f.path !== path);
      let nextActive = s.activePath;
      if (s.activePath === path) {
        const idx = s.openFiles.findIndex((f) => f.path === path);
        nextActive = filtered[idx]?.path ?? filtered[idx - 1]?.path ?? filtered[0]?.path ?? null;
      }
      return { ...s, openFiles: filtered, activePath: nextActive };
    });
  }, []);

  const setActive = useCallback((path: string) => {
    setState((s) => ({ ...s, activePath: path }));
  }, []);

  const updateActiveContent = useCallback((content: string) => {
    setState((s) => {
      if (!s.activePath) return s;
      const next = s.openFiles.map((f) =>
        f.path === s.activePath ? { ...f, content, dirty: true } : f,
      );
      return { ...s, openFiles: next };
    });
  }, []);

  const setSelection = useCallback((text: string) => {
    setState((s) => ({ ...s, selection: text }));
  }, []);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const saveActiveFile = useCallback(async () => {
    const s = stateRef.current;
    const toSave = s.openFiles.find((f) => f.path === s.activePath);
    if (!toSave || !toSave.dirty) return false;
    try {
      await window.suxai.fs.writeFile(toSave.path, toSave.content);
      setState((prev) => ({
        ...prev,
        openFiles: prev.openFiles.map((f) =>
          f.path === toSave.path ? { ...f, dirty: false } : f,
        ),
      }));
      return true;
    } catch (err) {
      console.error('Failed to save file:', err);
      return false;
    }
  }, []);

  const openDiff = useCallback((d: PendingDiff) => {
    setState((s) => ({ ...s, pendingDiff: d }));
  }, []);

  const closeDiff = useCallback(() => {
    setState((s) => ({ ...s, pendingDiff: null }));
  }, []);

  const acceptDiff = useCallback(() => {
    setState((s) => {
      const d = s.pendingDiff;
      if (!d) return s;
      const next = s.openFiles.map((f) =>
        f.path === d.path ? { ...f, content: d.proposed, dirty: true } : f,
      );
      return { ...s, openFiles: next, pendingDiff: null, activePath: d.path };
    });
  }, []);

  const activeFile = useMemo(
    () => state.openFiles.find((f) => f.path === state.activePath) ?? null,
    [state.openFiles, state.activePath],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      ...state,
      activeFile,
      setWorkspaceRoot,
      openFile,
      closeFile,
      setActive,
      updateActiveContent,
      setSelection,
      saveActiveFile,
      openDiff,
      closeDiff,
      acceptDiff,
    }),
    [
      state, activeFile, setWorkspaceRoot, openFile, closeFile, setActive,
      updateActiveContent, setSelection, saveActiveFile, openDiff, closeDiff, acceptDiff,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return ctx;
}
