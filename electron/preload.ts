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
    readFile: (p: string): Promise<{
      path: string;
      content: string;
      mtimeMs: number;
      /** v3.5 — line ending detected at read time. */
      eol: 'LF' | 'CRLF';
      /** v3.5 — file encoding (currently UTF-8 ± BOM). */
      encoding: 'UTF-8' | 'UTF-8 with BOM';
    }> =>
      ipcRenderer.invoke('fs:read-file', p),
    /** v3.5 — change the saved EOL of a file. Doesn't touch the
     *  current visible content ; the next writeFile will serialise
     *  with the new EOL via applyQuirks(). */
    setEol: (input: { path: string; eol: 'LF' | 'CRLF' }): Promise<{
      ok: true;
    } | { ok: false; error: string }> => ipcRenderer.invoke('fs:set-eol', input),
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
    /** v0.16.16 — git fetch --prune. */
    fetch: (input: { cwd: string }): Promise<{
      ok: true; output: string
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:fetch', input),
    /** v0.16.16 — git pull --ff-only. */
    pull: (input: { cwd: string }): Promise<{
      ok: true; output: string
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:pull', input),
    /** v0.16.16 — git push (--force-with-lease if force=true). */
    push: (input: { cwd: string; force?: boolean }): Promise<{
      ok: true; output: string
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:push', input),
    /** v0.16.16 — git rev-parse --abbrev-ref HEAD (current branch name). */
    currentBranch: (input: { cwd: string }): Promise<{
      ok: true; branch: string
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:current-branch', input),
    /** v0.16.16 — ahead/behind counts vs the configured upstream. */
    aheadBehind: (input: { cwd: string }): Promise<{
      ok: true; ahead: number; behind: number; hasUpstream: boolean
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:ahead-behind', input),
    /** v0.16.16 — list local + remote branches with metadata. */
    branches: (input: { cwd: string }): Promise<{
      ok: true; branches: { name: string; isCurrent: boolean; upstream?: string; lastCommitRel?: string; isRemote: boolean }[]
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:branches', input),
    /** v0.16.16 — checkout existing branch, or create new with -b. */
    checkout: (input: { cwd: string; branch: string; create?: boolean }): Promise<{
      ok: true
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:checkout', input),
    /** v2.3 — `git blame --line-porcelain HEAD <file>` parsed.
     *  Returns one BlameLine per source line, or `lines: []` for
     *  files git doesn't know about (untracked / new). */
    blame: (input: { cwd: string; file: string }): Promise<{
      ok: true;
      lines: { sha: string; author: string; dateIso: string; summary: string }[];
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:blame', input),
    /** v2.3 — `git log -n<limit>` with field-separator parsing.
     *  Default limit 100, capped at 1000. */
    log: (input: { cwd: string; limit?: number }): Promise<{
      ok: true;
      commits: { sha: string; shortSha: string; author: string; dateIso: string; subject: string; body: string }[];
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:log', input),
    /** v2.3 — list stashes (oldest index = highest in `git stash list`). */
    stashList: (input: { cwd: string }): Promise<{
      ok: true;
      stashes: { ref: string; index: number; sha: string; subject: string; dateIso: string }[];
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:stash-list', input),
    /** v2.3 — `git stash push [-m <msg>] [--include-untracked]`. */
    stashPush: (input: { cwd: string; message?: string; includeUntracked?: boolean }): Promise<{
      ok: true; output: string;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:stash-push', input),
    /** v2.3 — `git stash pop stash@{N}` (apply + drop in one shot). */
    stashPop: (input: { cwd: string; index: number }): Promise<{
      ok: true;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:stash-pop', input),
    /** v2.3 — `git stash apply stash@{N}` (apply, keep stash). */
    stashApply: (input: { cwd: string; index: number }): Promise<{
      ok: true;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:stash-apply', input),
    /** v2.3 — `git stash drop stash@{N}` (delete without applying). */
    stashDrop: (input: { cwd: string; index: number }): Promise<{
      ok: true;
    } | { ok: false; error: string }> => ipcRenderer.invoke('git:stash-drop', input),
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
  lsp: {
    /** v0.16.14 — walk node_modules/@types/* + each direct dep's
     *  typings entry to feed Monaco's TS service so cross-package
     *  imports resolve (React, Express, lodash, …). Capped at
     *  100 packages / 200 KB per file / 8 MB total. */
    nodeModulesTypes: (input: { cwd: string }): Promise<{
      ok: true;
      libs: { uri: string; content: string }[];
      pkgRoot: string | null;
    } | { ok: false; error: string }> => ipcRenderer.invoke('lsp:node-modules-types', input),
  },
  tasks: {
    /** v0.16.12 — read .suxai/tasks.json from a workspace root.
     *  Returns at most 100 tasks ; each has label + command + optional
     *  group/description. Empty list on missing file. */
    read: (input: { cwd: string }): Promise<{
      ok: true;
      tasks: { label: string; command: string; group?: string; description?: string }[];
      path: string;
    } | { ok: false; error: string }> => ipcRenderer.invoke('tasks:read', input),
  },
  snippets: {
    /** v0.16.11 — read user snippets from userData/snippets.json. */
    read: (): Promise<{
      ok: true; snippets: Record<string, Record<string, { prefix: string; body: string | string[]; description?: string }>>; path: string;
    } | { ok: false; error: string }> => ipcRenderer.invoke('snippets:read'),
    /** Persist user snippets ; renderer broadcasts a refresh after. */
    save: (input: { snippets: unknown }): Promise<{
      ok: true
    } | { ok: false; error: string }> => ipcRenderer.invoke('snippets:save', input),
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
    /** v3.8 — Streaming variant. Resolves when the process exits ;
     *  chunks arrive via `onRunStreamChunk`. Pass a `id` so multiple
     *  concurrent streams can be discriminated. */
    runStream: (input: {
      id: string;
      command: string;
      cwd?: string;
      timeout_ms?: number;
    }): Promise<{
      ok: true;
      id: string;
      exit_code: number;
      timed_out?: boolean;
    } | { ok: false; error: string }> => ipcRenderer.invoke('terminal:run-stream', input),
    onRunStreamChunk: (
      cb: (payload: { id: string; level: 'stdout' | 'stderr'; text: string }) => void,
    ) => {
      const listener = (_: unknown, p: { id: string; level: 'stdout' | 'stderr'; text: string }) => cb(p);
      ipcRenderer.on('terminal:run-stream:chunk', listener);
      return () => ipcRenderer.removeListener('terminal:run-stream:chunk', listener);
    },
    onRunStreamEnd: (
      cb: (payload: { id: string; exit_code: number; timed_out?: boolean; error?: string }) => void,
    ) => {
      const listener = (_: unknown, p: { id: string; exit_code: number; timed_out?: boolean; error?: string }) => cb(p);
      ipcRenderer.on('terminal:run-stream:end', listener);
      return () => ipcRenderer.removeListener('terminal:run-stream:end', listener);
    },
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
