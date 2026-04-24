import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty?: boolean;
  language?: string;
}

interface WorkspaceState {
  workspaceRoot: string | null;
  openFiles: OpenFile[];
  activePath: string | null;
  selection: string;
}

interface WorkspaceValue extends WorkspaceState {
  setWorkspaceRoot: (root: string | null) => void;
  openFile: (file: OpenFile) => void;
  closeFile: (path: string) => void;
  setActive: (path: string) => void;
  updateActiveContent: (content: string) => void;
  setSelection: (text: string) => void;
  activeFile: OpenFile | null;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', css: 'css', html: 'html', py: 'python',
    go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp',
    rb: 'ruby', php: 'php', sh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    sql: 'sql',
  };
  return map[ext] ?? 'plaintext';
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>({
    workspaceRoot: null,
    openFiles: [],
    activePath: null,
    selection: '',
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
    }),
    [state, activeFile, setWorkspaceRoot, openFile, closeFile, setActive, updateActiveContent, setSelection],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return ctx;
}
