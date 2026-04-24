import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty?: boolean;
  language?: string;
  pinned?: boolean;
  /** True for files created in-memory that haven't been saved to disk yet. */
  untitled?: boolean;
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
  closeOthers: (keepPath: string) => void;
  closeToTheRight: (fromPath: string) => void;
  closeAll: () => void;
  setActive: (path: string) => void;
  updateActiveContent: (content: string) => void;
  setSelection: (text: string) => void;
  saveActiveFile: () => Promise<boolean>;
  newUntitled: () => void;
  reorderTab: (fromPath: string, toPath: string) => void;
  togglePin: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => void;
  hasUnsaved: boolean;
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

const PERSIST_KEY = 'suxai.workspace.v1';

interface PersistedWorkspace {
  workspaceRoot: string | null;
  openPaths: string[];
  activePath: string | null;
}

function loadPersisted(): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(state: PersistedWorkspace): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
  } catch {
    /* quota etc. — ignore */
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>({
    workspaceRoot: null,
    openFiles: [],
    activePath: null,
    selection: '',
    pendingDiff: null,
  });
  const [restored, setRestored] = useState(false);

  const setWorkspaceRoot = useCallback((root: string | null) => {
    setState((s) => ({ ...s, workspaceRoot: root }));
  }, []);

  // Restore last session on first mount.
  useEffect(() => {
    if (restored) return;
    const persisted = loadPersisted();
    if (!persisted) {
      setRestored(true);
      return;
    }
    (async () => {
      try {
        if (persisted.workspaceRoot) {
          setState((s) => ({ ...s, workspaceRoot: persisted.workspaceRoot }));
        }
        const files: OpenFile[] = [];
        for (const p of persisted.openPaths ?? []) {
          try {
            const f = await window.suxai.fs.readFile(p);
            const name = p.split(/[\\/]/).pop() ?? p;
            files.push({
              path: f.path,
              name,
              content: f.content,
              language: langFromPath(f.path),
            });
          } catch {
            /* file moved/deleted since last session — skip silently */
          }
        }
        if (files.length > 0) {
          const active =
            persisted.activePath && files.some((f) => f.path === persisted.activePath)
              ? persisted.activePath
              : files[0].path;
          setState((s) => ({ ...s, openFiles: files, activePath: active }));
        }
      } finally {
        setRestored(true);
      }
    })();
  }, [restored]);

  // Persist on change, only after restoration ran so we don't blow it away.
  useEffect(() => {
    if (!restored) return;
    savePersisted({
      workspaceRoot: state.workspaceRoot,
      openPaths: state.openFiles.map((f) => f.path),
      activePath: state.activePath,
    });
  }, [restored, state.workspaceRoot, state.openFiles, state.activePath]);

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
    if (!toSave) return false;

    let targetPath = toSave.path;
    let alreadyWritten = false;

    if (toSave.untitled) {
      // Save-As flow: the dialog handler also writes the file, so we
      // don't need a second writeFile afterwards.
      try {
        const picked = await window.suxai.fs.saveAs?.(toSave.content, toSave.name);
        if (!picked) return false;
        targetPath = picked;
        alreadyWritten = true;
      } catch (err) {
        console.error('[save-as] failed:', err);
        return false;
      }
    } else if (!toSave.dirty) {
      return false;
    }

    try {
      if (!alreadyWritten) {
        await window.suxai.fs.writeFile(targetPath, toSave.content);
      }
      setState((prev) => ({
        ...prev,
        openFiles: prev.openFiles.map((f) =>
          f.path === toSave.path
            ? {
                ...f,
                path: targetPath,
                name: targetPath.split(/[\\/]/).pop() ?? f.name,
                dirty: false,
                untitled: false,
                language: langFromPath(targetPath),
              }
            : f,
        ),
        activePath: prev.activePath === toSave.path ? targetPath : prev.activePath,
      }));
      return true;
    } catch (err) {
      console.error('Failed to save file:', err);
      return false;
    }
  }, []);

  const closeOthers = useCallback((keepPath: string) => {
    setState((s) => {
      const filtered = s.openFiles.filter((f) => f.path === keepPath || f.pinned);
      return {
        ...s,
        openFiles: filtered,
        activePath: filtered.some((f) => f.path === keepPath) ? keepPath : filtered[0]?.path ?? null,
      };
    });
  }, []);

  const closeToTheRight = useCallback((fromPath: string) => {
    setState((s) => {
      const idx = s.openFiles.findIndex((f) => f.path === fromPath);
      if (idx < 0) return s;
      const kept = s.openFiles.filter((f, i) => i <= idx || f.pinned);
      return {
        ...s,
        openFiles: kept,
        activePath: kept.some((f) => f.path === s.activePath)
          ? s.activePath
          : fromPath,
      };
    });
  }, []);

  const closeAll = useCallback(() => {
    setState((s) => {
      const kept = s.openFiles.filter((f) => f.pinned);
      return {
        ...s,
        openFiles: kept,
        activePath: kept[0]?.path ?? null,
      };
    });
  }, []);

  const newUntitled = useCallback(() => {
    setState((s) => {
      let i = 1;
      // Keep incrementing until the name is free.
      while (s.openFiles.some((f) => f.path === `untitled://${i}`)) i++;
      const virtualPath = `untitled://${i}`;
      const entry: OpenFile = {
        path: virtualPath,
        name: `Untitled-${i}`,
        content: '',
        dirty: true,
        untitled: true,
        language: 'plaintext',
      };
      return { ...s, openFiles: [...s.openFiles, entry], activePath: virtualPath };
    });
  }, []);

  const reorderTab = useCallback((fromPath: string, toPath: string) => {
    setState((s) => {
      const from = s.openFiles.findIndex((f) => f.path === fromPath);
      const to = s.openFiles.findIndex((f) => f.path === toPath);
      if (from < 0 || to < 0 || from === to) return s;
      const next = s.openFiles.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...s, openFiles: next };
    });
  }, []);

  const togglePin = useCallback((path: string) => {
    setState((s) => ({
      ...s,
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, pinned: !f.pinned } : f)),
    }));
  }, []);

  const renameFile = useCallback((oldPath: string, newPath: string) => {
    setState((s) => {
      // If the destination is already open, drop the stale tab first so
      // we don't end up with two entries pointing at the same path.
      const withoutDest = s.openFiles.filter((f) => f.path !== newPath || f.path === oldPath);
      return {
        ...s,
        openFiles: withoutDest.map((f) =>
          f.path === oldPath
            ? {
                ...f,
                path: newPath,
                name: newPath.split(/[\\/]/).pop() ?? f.name,
                language: langFromPath(newPath),
              }
            : f,
        ),
        activePath: s.activePath === oldPath ? newPath : s.activePath,
      };
    });
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

  const hasUnsaved = useMemo(
    () => state.openFiles.some((f) => f.dirty && !f.untitled),
    [state.openFiles],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      ...state,
      activeFile,
      hasUnsaved,
      setWorkspaceRoot,
      openFile,
      closeFile,
      closeOthers,
      closeToTheRight,
      closeAll,
      setActive,
      updateActiveContent,
      setSelection,
      saveActiveFile,
      newUntitled,
      reorderTab,
      togglePin,
      renameFile,
      openDiff,
      closeDiff,
      acceptDiff,
    }),
    [
      state, activeFile, hasUnsaved, setWorkspaceRoot, openFile, closeFile,
      closeOthers, closeToTheRight, closeAll, setActive,
      updateActiveContent, setSelection, saveActiveFile, newUntitled, reorderTab,
      togglePin, renameFile, openDiff, closeDiff, acceptDiff,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return ctx;
}
