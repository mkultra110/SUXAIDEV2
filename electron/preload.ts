import { contextBridge, ipcRenderer } from 'electron';

type FileEntry = { name: string; path: string; isDirectory: boolean };
type OpenFileResult = { path: string; content: string } | null;

/**
 * v0.12.1 (audit #29): freeze the bridged API recursively before
 * exposing it. Prevents a renderer with eval-power (XSS) from
 * monkey-patching, e.g., `window.suxai.fs.writeFile = () => {}` to
 * silently no-op disk writes. contextBridge already prevents
 * prototype-chain pollution, but the leaf method references are
 * mutable references on the exposed object.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && (typeof child === 'object' || typeof child === 'function')) {
      deepFreeze(child);
    }
  }
  return value;
}

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
    /** v0.11.13: tells the renderer whether tokens are encrypted at
     *  rest by the OS keychain, or stored in plaintext (Linux without
     *  gnome-keyring/kwallet). The renderer surfaces a one-time
     *  warning toast on plaintext setups. */
    storageBackend: (): Promise<'native' | 'basic_text' | 'unavailable'> =>
      ipcRenderer.invoke('auth:storage-backend'),
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
    readFile: (p: string): Promise<{ path: string; content: string; mtimeMs: number }> =>
      ipcRenderer.invoke('fs:read-file', p),
    writeFile: (
      p: string,
      content: string,
      opts?: { skipMtimeCheck?: boolean },
    ): Promise<boolean> =>
      ipcRenderer.invoke('fs:write-file', p, content, opts),
    forgetMtime: (p: string): Promise<boolean> =>
      ipcRenderer.invoke('fs:forget-mtime', p),
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
  git: {
    /** v0.15.4 — porcelain git status for sidebar badges. Returns
     *  absolute-path → status-letter map (M/A/D/U/R/C). Bails with
     *  ok:false when `git` is missing or the cwd isn't a repo — the
     *  sidebar then just hides every badge. */
    status: (input: { cwd: string }): Promise<{
      ok: true;
      root: string;
      statuses: Record<string, string>;
      /** v0.16.0 — raw porcelain XY per path (X = index, Y = worktree).
       *  Lets callers bucket Staged vs Unstaged vs Untracked vs
       *  Conflicts without re-querying. */
      detail: Record<string, { x: string; y: string }>;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:status', input),
    /** v0.16.0 — stage one or more paths (`git add --`). Paths are
     *  absolute or repo-relative ; the main process re-resolves the
     *  toplevel and rejects traversal segments. */
    stage: (input: { cwd: string; paths: string[] }): Promise<{
      ok: true;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:stage', input),
    /** v0.16.0 — unstage (`git restore --staged --` with reset HEAD
     *  fallback for git < 2.23). */
    unstage: (input: { cwd: string; paths: string[] }): Promise<{
      ok: true;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:unstage', input),
    /** v0.16.0 — commit. Message piped via stdin to side-step argv
     *  length limits + multiline shell-escape headaches. */
    commit: (input: { cwd: string; message: string }): Promise<{
      ok: true;
      branch: string | null;
      sha: string | null;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:commit', input),
  },
  mcp: {
    /** v0.16.10 — list configured MCP servers + their connection status. */
    listServers: (): Promise<Array<{
      name: string;
      command: string;
      args: string[];
      status: 'starting' | 'ready' | 'error';
      errorMsg?: string;
      toolCount: number;
    }>> => ipcRenderer.invoke('mcp:list-servers'),
    /** List tools across all (or one specific) connected server. */
    listTools: (input: { server?: string } = {}): Promise<Array<{
      server: string;
      name: string;
      description?: string;
    }>> => ipcRenderer.invoke('mcp:list-tools', input),
    /** Invoke an MCP tool by server + name. */
    callTool: (input: { server: string; tool: string; arguments?: unknown }): Promise<{
      ok: true; result: unknown
    } | { ok: false; error: string }> => ipcRenderer.invoke('mcp:call-tool', input),
    /** Read the on-disk config (mcp.json under userData). */
    readConfig: (): Promise<{
      ok: true; config: { servers?: Record<string, unknown> }; path: string
    }> => ipcRenderer.invoke('mcp:read-config'),
    /** Persist a new config + reload affected servers. */
    saveConfig: (input: { config: unknown }): Promise<{
      ok: true
    } | { ok: false; error: string }> => ipcRenderer.invoke('mcp:save-config', input),
  },
  history: {
    /** v0.16.7 — fire-and-forget snapshot of file content. Skips if
     *  identical to last snapshot, if < 5s since last, or if > 4 MB.
     *  Caps at 50 entries per file (oldest dropped). */
    snapshot: (input: { path: string; content: string }): Promise<{
      ok: true; ts?: number; skipped?: boolean; reason?: string
    } | { ok: false; error: string; skipped?: boolean }> =>
      ipcRenderer.invoke('history:snapshot', input),
    /** List snapshots for a path, most-recent first. */
    list: (input: { path: string }): Promise<{
      ok: true; sha8: string; snapshots: { id: string; ts: number; sizeBytes: number }[]
    } | { ok: false; error: string }> =>
      ipcRenderer.invoke('history:list', input),
    /** Read a single snapshot by sha8 (path hash) + id (epoch ms). */
    read: (input: { sha8: string; id: string }): Promise<{
      ok: true; content: string
    } | { ok: false; error: string }> =>
      ipcRenderer.invoke('history:read', input),
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

contextBridge.exposeInMainWorld('suxai', deepFreeze(api));

export type SuxaiApi = typeof api;
