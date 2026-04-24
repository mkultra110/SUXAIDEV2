import { contextBridge, ipcRenderer } from 'electron';

type FileEntry = { name: string; path: string; isDirectory: boolean };
type OpenFileResult = { path: string; content: string } | null;

const api = {
  auth: {
    getToken: (): Promise<string | null> => ipcRenderer.invoke('auth:get-token'),
    setToken: (token: string): Promise<boolean> => ipcRenderer.invoke('auth:set-token', token),
    clearToken: (): Promise<boolean> => ipcRenderer.invoke('auth:clear-token'),
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: (): Promise<void> => ipcRenderer.invoke('window:maximize-toggle'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  },
  fs: {
    openFile: (): Promise<OpenFileResult> => ipcRenderer.invoke('fs:open-file'),
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('fs:open-folder'),
    readDir: (p: string): Promise<FileEntry[]> => ipcRenderer.invoke('fs:read-dir', p),
    readFile: (p: string): Promise<{ path: string; content: string }> =>
      ipcRenderer.invoke('fs:read-file', p),
    writeFile: (p: string, content: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:write-file', p, content),
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
