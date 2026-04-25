import { contextBridge, ipcRenderer } from 'electron';

type FileEntry = { name: string; path: string; isDirectory: boolean };
type OpenFileResult = { path: string; content: string } | null;

const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  },
  auth: {
    getToken: (): Promise<string | null> => ipcRenderer.invoke('auth:get-token'),
    setToken: (token: string): Promise<boolean> => ipcRenderer.invoke('auth:set-token', token),
    clearToken: (): Promise<boolean> => ipcRenderer.invoke('auth:clear-token'),
    getRefreshToken: (): Promise<string | null> => ipcRenderer.invoke('auth:get-refresh-token'),
    setRefreshToken: (token: string): Promise<boolean> =>
      ipcRenderer.invoke('auth:set-refresh-token', token),
    clearRefreshToken: (): Promise<boolean> => ipcRenderer.invoke('auth:clear-refresh-token'),
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: (): Promise<void> => ipcRenderer.invoke('window:maximize-toggle'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    setTitle: (title: string): Promise<void> =>
      ipcRenderer.invoke('window:set-title', title),
    setDirty: (dirty: boolean): Promise<void> =>
      ipcRenderer.invoke('window:set-dirty', dirty),
    onCloseRequested: (cb: () => void) => {
      const listener = () => cb();
      ipcRenderer.on('window:close-requested', listener);
      return () => ipcRenderer.removeListener('window:close-requested', listener);
    },
    confirmClose: (): Promise<void> => ipcRenderer.invoke('window:confirm-close'),
  },
  fs: {
    openFile: (): Promise<OpenFileResult> => ipcRenderer.invoke('fs:open-file'),
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('fs:open-folder'),
    readDir: (p: string): Promise<FileEntry[]> => ipcRenderer.invoke('fs:read-dir', p),
    readFile: (p: string): Promise<{ path: string; content: string }> =>
      ipcRenderer.invoke('fs:read-file', p),
    writeFile: (p: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:write-file', p, content),
    saveAs: (content: string, suggestedName?: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:save-as', content, suggestedName),
    createFile: (parent: string, name: string): Promise<string> =>
      ipcRenderer.invoke('fs:create-file', parent, name),
    createDir: (parent: string, name: string): Promise<string> =>
      ipcRenderer.invoke('fs:create-dir', parent, name),
    rename: (oldPath: string, newPath: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:rename', oldPath, newPath),
    remove: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:remove', p),
    revealInFolder: (p: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:reveal', p),
  },
  conversations: {
    read: (): Promise<unknown> => ipcRenderer.invoke('conv:read'),
    write: (data: unknown): Promise<boolean> => ipcRenderer.invoke('conv:write', data),
    clear: (): Promise<boolean> => ipcRenderer.invoke('conv:clear'),
  },
  plan: {
    write: (workspaceRoot: string, slug: string, content: string): Promise<{ path: string }> =>
      ipcRenderer.invoke('plan:write', workspaceRoot, slug, content),
  },
  commands: {
    list: (workspaceRoot: string): Promise<
      Array<{
        name: string;
        path: string;
        description?: string;
        mode?: 'composer' | 'ask';
        body: string;
      }>
    > => ipcRenderer.invoke('commands:list', workspaceRoot),
  },
  search: {
    grep: (input: {
      pattern: string;
      cwd: string;
      glob?: string;
      max_results?: number;
      case_sensitive?: boolean;
    }): Promise<{
      hits: { path: string; line: number; text: string }[];
      source?: string;
      error?: string;
    }> => ipcRenderer.invoke('search:grep', input),
  },
  checkpoint: {
    create: (workspaceRoot: string, turnId: string, files: string[]): Promise<{ id: string }> =>
      ipcRenderer.invoke('checkpoint:create', workspaceRoot, turnId, files),
    list: (workspaceRoot: string): Promise<
      { id: string; ts: number; files: string[]; conversationId?: string; trigger?: string }[]
    > => ipcRenderer.invoke('checkpoint:list', workspaceRoot),
    restore: (workspaceRoot: string, turnId: string): Promise<{ restored: string[] }> =>
      ipcRenderer.invoke('checkpoint:restore', workspaceRoot, turnId),
  },
  terminal: {
    spawn: (cwd?: string): Promise<{ id: string; shell: string }> =>
      ipcRenderer.invoke('terminal:spawn', cwd),
    write: (id: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke('terminal:kill', id),
    runOnce: (input: {
      command: string;
      cwd?: string;
      timeout_ms?: number;
    }): Promise<{
      stdout: string;
      exit_code: number;
      timed_out?: boolean;
      error?: string;
    }> => ipcRenderer.invoke('terminal:run-once', input),
    onData: (cb: (payload: { id: string; chunk: string }) => void) => {
      const listener = (_: unknown, p: { id: string; chunk: string }) => cb(p);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    onExit: (cb: (payload: { id: string; code: number | null }) => void) => {
      const listener = (_: unknown, p: { id: string; code: number | null }) => cb(p);
      ipcRenderer.on('terminal:exit', listener);
      return () => ipcRenderer.removeListener('terminal:exit', listener);
    },
  },
  update: {
    check: (): Promise<{ available: boolean; version: string; notes?: string } | null> =>
      ipcRenderer.invoke('update:check'),
    downloadAndInstall: (): Promise<boolean> => ipcRenderer.invoke('update:download-and-install'),
    onProgress: (cb: (p: { percent: number; transferred: number; total: number }) => void) => {
      const listener = (_: unknown, payload: any) => cb(payload);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
    onStatus: (cb: (status: string) => void) => {
      const listener = (_: unknown, status: string) => cb(status);
      ipcRenderer.on('update:status', listener);
      return () => ipcRenderer.removeListener('update:status', listener);
    },
  },
};

contextBridge.exposeInMainWorld('suxai', api);

export type SuxaiApi = typeof api;
