import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { UpdateManager } from './updater';

function createHashHex(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 24);
}

process.env.APP_ROOT = path.join(__dirname, '..');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST;

const USER_DATA = () => app.getPath('userData');
const TOKEN_FILE = () => path.join(USER_DATA(), 'auth.bin');
const REFRESH_TOKEN_FILE = () => path.join(USER_DATA(), 'refresh.bin');
const CONVERSATIONS_FILE = () => path.join(USER_DATA(), 'conversations.json');

let mainWindow: BrowserWindow | null = null;
let updateManager: UpdateManager | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0f17',
      symbolColor: '#e8ecf4',
      height: 36,
    },
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // Force-show the window even if the renderer takes too long / crashes.
  // Without this, a single preload or bootstrap error leaves a zombie
  // process with no visible window.
  const forceShowTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[suxai] ready-to-show did not fire in 3s — force-showing window');
      mainWindow.show();
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  }, 3000);

  mainWindow.once('ready-to-show', () => {
    clearTimeout(forceShowTimer);
    mainWindow?.show();
  });

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
    // Users can open DevTools manually with Ctrl/Cmd+Shift+I or F12 if
    // something goes wrong, but don't open automatically in production.
  }

  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error('[renderer] did-fail-load', { code, description, url });
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone', details);
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[renderer] unresponsive');
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    // Prevent the force-show fallback from firing after the window is
    // gone — otherwise quitting during the 3-second startup window
    // logs a spurious warning and leaves a dangling timer.
    clearTimeout(forceShowTimer);
    mainWindow = null;
  });

  // Renderer owns the unsaved-changes state; intercept close and ask it.
  let confirmedClose = false;
  mainWindow.on('close', (e) => {
    if (confirmedClose) return;
    e.preventDefault();
    mainWindow?.webContents.send('window:close-requested');
  });
  ipcMain.handle('window:confirm-close', () => {
    confirmedClose = true;
    mainWindow?.close();
  });
}

async function readTokenBlob(): Promise<string | null> {
  try {
    const buf = await fs.readFile(TOKEN_FILE());
    if (!safeStorage.isEncryptionAvailable()) return buf.toString('utf8');
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

/**
 * Inspect the safeStorage encryption backend (Linux only matters
 * for the answer — macOS uses Keychain, Windows uses DPAPI, both
 * always strong). Returns one of:
 *   - 'native'      : encryption is via OS keychain/DPAPI/libsecret/kwallet
 *   - 'basic_text'  : Linux without keychain — tokens stored in CLEAR TEXT
 *   - 'unavailable' : safeStorage isn't ready yet (very early boot)
 *
 * The renderer calls auth:storage-backend at startup and shows a
 * one-time warning toast when 'basic_text' is detected so the user
 * understands their refresh token is on disk in plaintext.
 */
ipcMain.handle('auth:storage-backend', () => {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  // getSelectedStorageBackend exists on Electron 14+; older builds
  // don't have it. Treat its absence as 'native' (we have to assume
  // the OS keychain on macOS / Windows / etc.).
  const fn = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
  if (typeof fn !== 'function') return 'native';
  try {
    const backend = fn.call(safeStorage);
    return backend === 'basic_text' ? 'basic_text' : 'native';
  } catch {
    return 'native';
  }
});

async function writeTokenBlob(token: string): Promise<void> {
  await fs.mkdir(USER_DATA(), { recursive: true });
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, 'utf8');
  await fs.writeFile(TOKEN_FILE(), data, { mode: 0o600 });
}

async function clearTokenBlob(): Promise<void> {
  try {
    await fs.unlink(TOKEN_FILE());
  } catch {
    /* noop */
  }
}

async function readBlob(file: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(file);
    if (!safeStorage.isEncryptionAvailable()) return buf.toString('utf8');
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

async function writeBlob(file: string, value: string): Promise<void> {
  await fs.mkdir(USER_DATA(), { recursive: true });
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value)
    : Buffer.from(value, 'utf8');
  await fs.writeFile(file, data, { mode: 0o600 });
}

async function deleteBlob(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch {
    /* noop */
  }
}

function registerIpc() {
  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('auth:get-token', async () => readTokenBlob());
  ipcMain.handle('auth:set-token', async (_e, token: string) => {
    if (typeof token !== 'string' || token.length === 0) throw new Error('Invalid token');
    await writeTokenBlob(token);
    return true;
  });
  ipcMain.handle('auth:clear-token', async () => {
    await clearTokenBlob();
    return true;
  });

  ipcMain.handle('auth:get-refresh-token', () => readBlob(REFRESH_TOKEN_FILE()));
  ipcMain.handle('auth:set-refresh-token', async (_e, token: string) => {
    if (typeof token !== 'string' || token.length === 0) throw new Error('Invalid refresh token');
    await writeBlob(REFRESH_TOKEN_FILE(), token);
    return true;
  });
  ipcMain.handle('auth:clear-refresh-token', async () => {
    await deleteBlob(REFRESH_TOKEN_FILE());
    return true;
  });

  // ---- Conversation history (plain JSON in userData) ------------------------
  // Not encrypted on purpose — the contents aren't secret, and we want
  // the user to be able to inspect/export the file manually. Use a
  // temp-rename for atomic writes so a crash mid-write can't corrupt it.
  ipcMain.handle('conv:read', async () => {
    let raw: string;
    try {
      raw = await fs.readFile(CONVERSATIONS_FILE(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[conv:read] could not read file:', err);
      }
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      // Corrupted JSON would otherwise be silently nuked the next time
      // conv:write fires. Surface it loudly and rename the bad file
      // so the user (or a support engineer) can recover messages from
      // it manually instead of losing them outright.
      console.error('[conv:read] corrupted JSON, preserving as .corrupt-<ts>:', err);
      try {
        const bak = `${CONVERSATIONS_FILE()}.corrupt-${Date.now()}`;
        await fs.rename(CONVERSATIONS_FILE(), bak);
        console.error(`[conv:read] saved corrupt copy to ${bak}`);
      } catch (renameErr) {
        console.error('[conv:read] could not preserve corrupt file:', renameErr);
      }
      return null;
    }
  });
  ipcMain.handle('conv:write', async (_e, data: unknown) => {
    // Accept any JSON-serialisable payload — the old contract was
    // "array of messages", the new one is { version, active, list }.
    if (data === null || data === undefined) {
      throw new Error('Conversations payload required');
    }
    await fs.mkdir(USER_DATA(), { recursive: true });
    // Atomic write + fsync, same durability story as fs:write-file.
    // A crash mid-write would otherwise corrupt the file and trigger
    // the rename-as-corrupt path on next read.
    const tmp = `${CONVERSATIONS_FILE()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(data));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, CONVERSATIONS_FILE());
    return true;
  });
  ipcMain.handle('conv:clear', async () => {
    try {
      await fs.unlink(CONVERSATIONS_FILE());
    } catch {
      /* noop */
    }
    return true;
  });

  // ---- Plan mode (Cursor-style "Plan / Ask" mode) -------------------
  // create_plan tool persists a structured markdown plan under
  // <workspace>/.suxai/plans/<slug>.md so the user can review it
  // before flipping the conversation back to composer mode for
  // execution. workspaceRoot is passed by the renderer because the
  // main process doesn't track it directly (the renderer is the
  // single source of truth for "current workspace").
  // ---- Custom slash commands ----------------------------------------
  // Markdown files dropped in <workspace>/.suxai/commands/<name>.md
  // become user-defined slash commands. Front-matter is optional but
  // when present (between --- fences) we parse `description` and
  // `mode` (composer | ask). The body is injected as the user's
  // next message verbatim. Variables {{selection}}, {{file}},
  // {{branch}} are substituted at invocation time by the renderer.
  ipcMain.handle(
    'commands:list',
    async (_e, workspaceRoot: string) => {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) return [];
      let safeRoot: string;
      try { safeRoot = sanitizeFsPath(workspaceRoot, { mustExist: true }); }
      catch { return []; }
      const dir = path.join(safeRoot, '.suxai', 'commands');
      let entries: string[];
      try { entries = await fs.readdir(dir); }
      catch { return []; /* directory just doesn't exist — fine */ }
      const out: Array<{
        name: string;
        path: string;
        description?: string;
        mode?: 'composer' | 'ask';
        body: string;
      }> = [];
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const name = entry.slice(0, -3).toLowerCase();
        if (!/^[a-z0-9_-]+$/.test(name)) continue; // ignore weird filenames
        let raw: string;
        try { raw = await fs.readFile(path.join(dir, entry), 'utf8'); }
        catch { continue; }
        // Optional YAML-like front-matter parser. Permissive: only
        // recognises `description:` and `mode:` keys; everything else
        // is forwarded as part of the body.
        let description: string | undefined;
        let mode: 'composer' | 'ask' | undefined;
        let body = raw;
        const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
        if (fm) {
          const lines = fm[1].split('\n');
          for (const line of lines) {
            const m = line.match(/^\s*(\w+)\s*:\s*"?([^"]*)"?\s*$/);
            if (!m) continue;
            const key = m[1].toLowerCase();
            const value = m[2].trim();
            if (key === 'description') description = value;
            if (key === 'mode' && (value === 'composer' || value === 'ask')) mode = value;
          }
          body = raw.slice(fm[0].length);
        }
        out.push({
          name,
          path: path.join(dir, entry),
          description,
          mode,
          body: body.trim(),
        });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },
  );

  ipcMain.handle(
    'plan:write',
    async (_e, workspaceRoot: string, slug: string, content: string) => {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        throw new Error('plan:write requires a workspaceRoot');
      }
      if (typeof slug !== 'string' || !/^[a-z0-9_-]+$/.test(slug)) {
        throw new Error('plan:write slug must be kebab-case');
      }
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('plan:write content cannot be empty');
      }
      // Sandbox: refuse anything that escapes the workspace root.
      const safeRoot = sanitizeFsPath(workspaceRoot, { mustExist: true });
      const plansDir = path.join(safeRoot, '.suxai', 'plans');
      await fs.mkdir(plansDir, { recursive: true });
      const target = path.join(plansDir, `${slug}.md`);
      // Atomic write + fsync, same as fs:write-file.
      const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(content, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, target);
      return { path: target };
    },
  );

  // ---- Checkpoints --------------------------------------------------
  // Snapshots of files at risk before each agent turn. Stored under
  // <userData>/checkpoints/<workspaceHash>/<turnId>/ so:
  //   - workspace privacy is preserved (per-workspace folder)
  //   - the user's open files don't pollute the workspace folder
  //   - we can prune old entries trivially (LRU 50 per workspace).
  // Used by the "Restore" button on each user message that triggered
  // an agent run.
  const checkpointDirFor = (workspaceRoot: string): string => {
    const hash = createHashHex(workspaceRoot);
    return path.join(USER_DATA(), 'checkpoints', hash);
  };

  ipcMain.handle(
    'checkpoint:create',
    async (_e, workspaceRoot: string, turnId: string, files: string[]) => {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        throw new Error('checkpoint:create requires workspaceRoot');
      }
      if (typeof turnId !== 'string' || turnId.length === 0) {
        throw new Error('checkpoint:create requires turnId');
      }
      if (!Array.isArray(files)) {
        throw new Error('checkpoint:create files must be an array');
      }
      const dir = path.join(checkpointDirFor(workspaceRoot), turnId);
      await fs.mkdir(dir, { recursive: true });
      const safePathFor = (rel: string) => rel.replace(/[/\\]/g, '__');
      const snapshotted: string[] = [];
      for (const f of files.slice(0, 50)) {
        // Hard cap 50 files per turn — heuristic should never propose
        // more, but defend anyway.
        if (typeof f !== 'string' || f.length === 0) continue;
        let safe: string;
        try { safe = sanitizeFsPath(f, { mustExist: true }); }
        catch { continue; /* file gone or denied — silently skip */ }
        try {
          const buf = await fs.readFile(safe);
          await fs.writeFile(path.join(dir, safePathFor(f) + '.bak'), buf);
          snapshotted.push(safe);
        } catch (err) {
          console.warn('[checkpoint] could not snapshot', f, err);
        }
      }
      // Manifest with metadata for `checkpoint:list`.
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify(
          { id: turnId, ts: Date.now(), files: snapshotted, workspaceRoot },
          null,
          2,
        ),
      );
      // LRU prune: keep the 50 most recent turn directories per
      // workspace.
      void pruneCheckpoints(workspaceRoot, 50);
      return { id: turnId };
    },
  );

  ipcMain.handle(
    'checkpoint:list',
    async (_e, workspaceRoot: string) => {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        throw new Error('checkpoint:list requires workspaceRoot');
      }
      const dir = checkpointDirFor(workspaceRoot);
      let entries: string[];
      try { entries = await fs.readdir(dir); }
      catch { return []; }
      const items: Array<{ id: string; ts: number; files: string[] }> = [];
      for (const e of entries) {
        try {
          const raw = await fs.readFile(path.join(dir, e, 'manifest.json'), 'utf8');
          const obj = JSON.parse(raw);
          if (obj && typeof obj.id === 'string') items.push(obj);
        } catch { /* skip malformed entries */ }
      }
      items.sort((a, b) => b.ts - a.ts);
      return items;
    },
  );

  ipcMain.handle(
    'checkpoint:restore',
    async (_e, workspaceRoot: string, turnId: string) => {
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
        throw new Error('checkpoint:restore requires workspaceRoot');
      }
      if (typeof turnId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(turnId)) {
        throw new Error('checkpoint:restore turnId is invalid');
      }
      const dir = path.join(checkpointDirFor(workspaceRoot), turnId);
      const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
      const manifest = JSON.parse(raw) as { files: string[] };
      if (!Array.isArray(manifest.files)) {
        throw new Error('Checkpoint manifest has no files');
      }
      const safePathFor = (abs: string) => {
        // Reverse of safePathFor used at create time — given the
        // snapshotted absolute path, find its .bak by looking at its
        // basename in the dir.
        const all = manifest.files;
        return all.find((p) => p === abs);
      };
      const restored: string[] = [];
      for (const abs of manifest.files) {
        const original = safePathFor(abs);
        if (!original) continue;
        let safe: string;
        try { safe = sanitizeFsPath(original); }
        catch { continue; }
        // The bak filename uses the ORIGINAL path with separators
        // replaced by __. To find it without the original-path map, we
        // walk the dir; for performance, we just compute the same
        // mangling we used at create time.
        const baks = await fs.readdir(dir);
        const target = baks.find(
          (b) => b.endsWith('.bak') && safe.endsWith(b.slice(0, -4).replace(/__/g, path.sep)),
        );
        if (!target) continue;
        try {
          const buf = await fs.readFile(path.join(dir, target));
          await fs.writeFile(safe, buf);
          restored.push(safe);
        } catch (err) {
          console.warn('[checkpoint] could not restore', abs, err);
        }
      }
      return { restored };
    },
  );

  async function pruneCheckpoints(workspaceRoot: string, keep: number): Promise<void> {
    const dir = checkpointDirFor(workspaceRoot);
    let entries: string[];
    try { entries = await fs.readdir(dir); }
    catch { return; }
    const stamped = await Promise.all(
      entries.map(async (e) => {
        try {
          const stat = await fs.stat(path.join(dir, e));
          return { name: e, mtime: stat.mtimeMs };
        } catch { return { name: e, mtime: 0 }; }
      }),
    );
    stamped.sort((a, b) => b.mtime - a.mtime);
    const stale = stamped.slice(keep);
    for (const s of stale) {
      try { await fs.rm(path.join(dir, s.name), { recursive: true, force: true }); }
      catch { /* */ }
    }
  }

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize-toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:set-title', (_e, title: string) => {
    if (typeof title === 'string') mainWindow?.setTitle(title);
  });
  ipcMain.handle('window:set-dirty', (_e, dirty: boolean) => {
    // macOS shows a filled dot in the close button when the document is
    // edited; other platforms we just prefix the title.
    mainWindow?.setDocumentEdited(!!dirty);
  });

  ipcMain.handle('fs:open-file', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  });

  ipcMain.handle('fs:open-folder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('fs:read-dir', async (_e, dirPath: string) => {
    // Run the path through the same allowlist as fs:read-file so a
    // rogue caller can't enumerate /etc, /root/.ssh, or any other
    // FS_DENY-listed directory. mustExist:true guarantees we don't
    // 404-leak by reflecting the input path on a non-existent target.
    const safe = sanitizeFsPath(dirPath, { mustExist: true });
    const entries = await fs.readdir(safe, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      path: path.join(safe, e.name),
      isDirectory: e.isDirectory(),
    }));
  });

  // --- Filesystem IPC (all user-initiated) -------------------------------
  //
  // Every path that crosses the renderer boundary is sanitized here.
  // We accept absolute paths only and require that the final resolved
  // path sits under a user-directory allowlist (workspace-picked folders
  // plus the OS home dir for bare file opens). In production we don't
  // carry a live notion of "the workspace" in the main process, so we
  // pragmatically reject obvious traversal patterns and disallow writes
  // to system paths — the renderer is isolated but a malicious/rogue
  // extension shouldn't be able to trash /etc or escape via `..`.
  const FS_DENY = ['/etc', '/boot', '/sys', '/proc', '/dev', '/root/.ssh'];

  function sanitizeFsPath(p: unknown, { mustExist = false } = {}): string {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('Invalid path');
    }
    // Reject paths with embedded NULs (classic bypass).
    if (p.includes('\0')) throw new Error('Invalid path');
    const normalized = path.resolve(p);
    if (!path.isAbsolute(normalized)) throw new Error('Path must be absolute');
    for (const deny of FS_DENY) {
      if (normalized === deny || normalized.startsWith(deny + path.sep)) {
        throw new Error('Access denied');
      }
    }
    if (mustExist && !fsSync.existsSync(normalized)) {
      throw new Error(`Path does not exist: ${normalized}`);
    }
    // v0.12.6 (audit #31): if the path is a symlink, resolve it and
    // re-check the FS_DENY allowlist against the real target. Without
    // this, a symlink at `~/repo/notes -> /etc/passwd` would slip
    // through the deny check (the link itself is in $HOME) and the
    // subsequent read would happily return /etc/passwd content.
    // realpath also collapses any chain so loops throw ELOOP from
    // the OS — we let that bubble up as "Access denied".
    if (mustExist) {
      try {
        const real = fsSync.realpathSync.native(normalized);
        if (real !== normalized) {
          for (const deny of FS_DENY) {
            if (real === deny || real.startsWith(deny + path.sep)) {
              throw new Error('Access denied (symlink target in deny list)');
            }
          }
        }
      } catch (err) {
        // ELOOP / EACCES / ENOENT — refuse to operate.
        throw new Error(
          (err as NodeJS.ErrnoException).code === 'ELOOP'
            ? 'Access denied (symlink loop)'
            : (err as Error).message,
        );
      }
    }
    return normalized;
  }

  // mtime tracking (v0.11.4): every fs:read-file stamps a sourceOfTruth
  // entry so subsequent fs:write-file (whether agent-driven via
  // edit_file or user-driven via Save/InlineDiff Accept) can detect
  // a concurrent external edit and refuse to clobber. Cleared on
  // explicit "I know what I'm doing" reload (fs:reload-mtime). Cap
  // 5K entries to avoid unbounded growth on a really long session.
  const lastSeenMtime = new Map<string, number>();
  const MTIME_CACHE_CAP = 5000;
  function rememberMtime(safePath: string, ms: number): void {
    if (lastSeenMtime.size >= MTIME_CACHE_CAP) {
      // FIFO eviction: drop oldest insertion — Map preserves insertion order.
      const first = lastSeenMtime.keys().next().value;
      if (first !== undefined) lastSeenMtime.delete(first);
    }
    lastSeenMtime.set(safePath, ms);
  }

  // v0.11.12: file format quirks (BOM + EOL) are tracked alongside
  // mtime so atomicWrite can round-trip a CRLF .bat or a UTF-8-BOM
  // JSON file unchanged. Without this, every agent edit silently
  // converted the file to LF + no-BOM — a noisy diff in git for the
  // user even when the actual code didn't change.
  interface FileQuirks {
    eol: '\r\n' | '\n';
    bom: boolean;
  }
  const lastSeenQuirks = new Map<string, FileQuirks>();
  function detectQuirks(raw: Buffer): FileQuirks {
    // BOM = first 3 bytes are EF BB BF (UTF-8 BOM). UTF-16 BOMs are
    // rarer and Monaco/Node read them as text differently — skip
    // for now, treat as no-BOM.
    const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    // Sniff EOL on the first 64 KB. CRLF if any \r\n found.
    const sample = raw.subarray(bom ? 3 : 0, Math.min(raw.length, 64 * 1024));
    let crlfCount = 0;
    let lfCount = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0x0a) {
        if (i > 0 && sample[i - 1] === 0x0d) crlfCount++;
        else lfCount++;
      }
    }
    return {
      eol: crlfCount > lfCount ? '\r\n' : '\n',
      bom,
    };
  }

  ipcMain.handle('fs:read-file', async (_e, filePath: string) => {
    const safe = sanitizeFsPath(filePath, { mustExist: true });
    const stat = await fs.stat(safe);
    rememberMtime(safe, stat.mtimeMs);
    const raw = await fs.readFile(safe);
    const quirks = detectQuirks(raw);
    lastSeenQuirks.set(safe, quirks);
    // Strip the BOM from the returned content (Monaco doesn't want
    // it inline) and normalise CRLF→LF so the renderer sees a
    // clean string. We restore both at write time.
    let content = quirks.bom ? raw.subarray(3).toString('utf8') : raw.toString('utf8');
    if (quirks.eol === '\r\n') content = content.replace(/\r\n/g, '\n');
    return { path: safe, content, mtimeMs: stat.mtimeMs };
  });

  /**
   * Forget the cached mtime for a path. Called by the renderer when
   * the user explicitly accepts a "file changed externally" prompt
   * to keep their pending edit, OR after a Save-As that landed at a
   * brand-new path. Without this, a stale mtime entry from a prior
   * session would cause every write to fail with STALE_FILE.
   */
  ipcMain.handle('fs:forget-mtime', async (_e, filePath: string) => {
    try {
      const safe = sanitizeFsPath(filePath);
      lastSeenMtime.delete(safe);
    } catch { /* path invalid — drop silently */ }
    return true;
  });

  // Shared helper: atomic write (tmp + fsync + rename) with EXDEV
  // fallback. Reused by fs:write-file and fs:save-as so user-initiated
  // saves and agent-initiated saves get the same durability guarantees.
  // v0.11.12: also reapplies the BOM + CRLF quirks captured at the
  // last read of this file. The renderer never sees those bytes; the
  // file on disk gets them back exactly as it had them.
  function applyQuirks(safe: string, content: string): string {
    const q = lastSeenQuirks.get(safe);
    if (!q) return content;
    let out = content;
    if (q.eol === '\r\n') {
      // Renderer normalised \r\n → \n at read time; restore here.
      out = out.replace(/\r?\n/g, '\r\n');
    }
    if (q.bom) out = '﻿' + out;
    return out;
  }
  // v0.12.3 (audit #19): opportunistic cleanup of leftover atomicWrite
  // tmp files. Pattern: `<basename>.<pid>.<timestamp>.<8-char>.tmp`.
  // We can't run a global boot-time scan (atomicWrite drops tmp files
  // anywhere in the user's workspace), but every successful rename is
  // a chance to sweep the same parent dir of orphans older than 24h —
  // a sane atomicWrite finishes in milliseconds, so anything older is
  // guaranteed to be from a crashed prior process.
  const TMP_NAME_PATTERN = /^.+\.\d+\.\d+\.[a-z0-9]+\.tmp$/i;
  const TMP_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
  async function sweepTmpOrphans(parentDir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(parentDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - TMP_ORPHAN_AGE_MS;
    await Promise.all(
      entries
        .filter((name) => TMP_NAME_PATTERN.test(name))
        .map(async (name) => {
          const full = path.join(parentDir, name);
          try {
            const st = await fs.stat(full);
            if (st.isFile() && st.mtimeMs < cutoff) {
              await fs.unlink(full);
            }
          } catch { /* */ }
        }),
    );
  }

  async function atomicWrite(safe: string, content: string): Promise<void> {
    // v0.11.12: round-trip the file's original BOM + CRLF marks
    // before the actual write. Renderer always passes a clean LF
    // string; we put the bytes back exactly as the file had them.
    const onDiskContent = applyQuirks(safe, content);
    const tmp = `${safe}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(onDiskContent, 'utf8');
        await fh.sync(); // flush page cache to disk before rename
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, safe);
      // Fire-and-forget orphan sweep — never blocks the write path.
      sweepTmpOrphans(path.dirname(safe)).catch(() => { /* */ });
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* */ }
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        const fh = await fs.open(safe, 'w');
        try {
          await fh.writeFile(onDiskContent, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        return;
      }
      throw err;
    }
  }

  ipcMain.handle('fs:write-file', async (
    _e,
    filePath: string,
    content: string,
    opts?: { skipMtimeCheck?: boolean },
  ) => {
    const safe = sanitizeFsPath(filePath);
    if (typeof content !== 'string') throw new Error('Content must be a string');
    // Concurrent-edit guard (v0.11.4): if we previously read this
    // file and the on-disk mtime has moved since, refuse to clobber.
    // Caller can opt out via { skipMtimeCheck: true } when the user
    // already acknowledged the warning in a "keep my version" modal.
    // Brand-new files (no entry in the map) always succeed — that's
    // a creation, not a clobber.
    const expected = lastSeenMtime.get(safe);
    if (expected !== undefined && !opts?.skipMtimeCheck) {
      try {
        const current = await fs.stat(safe);
        if (Math.abs(current.mtimeMs - expected) > 1) {
          // 1 ms tolerance — some FS round mtime to integer ms.
          const err = new Error(
            `${safe} was modified externally since SUXAI last read it. ` +
              `Reload the file or pass skipMtimeCheck:true to overwrite.`,
          );
          (err as Error & { code?: string }).code = 'STALE_FILE';
          throw err;
        }
      } catch (err) {
        // ENOENT means the file no longer exists — let the write
        // recreate it. Other stat errors propagate.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          if ((err as Error & { code?: string }).code === 'STALE_FILE') throw err;
          // permission etc — let the write try and fail naturally.
        }
      }
    }
    await atomicWrite(safe, content);
    // Refresh the cached mtime so subsequent reads/writes see the
    // post-write timestamp.
    try {
      const after = await fs.stat(safe);
      rememberMtime(safe, after.mtimeMs);
    } catch { /* */ }
    return true;
  });

  ipcMain.handle('fs:save-as', async (_e, content: string, suggestedName?: string) => {
    if (!mainWindow) return null;
    if (typeof content !== 'string') throw new Error('Content must be a string');
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedName,
    });
    if (result.canceled || !result.filePath) return null;
    const safe = sanitizeFsPath(result.filePath);
    await atomicWrite(safe, content);
    return safe;
  });

  ipcMain.handle('fs:create-file', async (_e, parent: string, name: string) => {
    const safeParent = sanitizeFsPath(parent, { mustExist: true });
    if (typeof name !== 'string' || name.length === 0 || /[\0/\\]/.test(name)) {
      throw new Error('Invalid filename');
    }
    const full = sanitizeFsPath(path.join(safeParent, name));
    // Reject if the resulting path escapes the parent (defence in depth).
    if (!full.startsWith(safeParent + path.sep) && full !== safeParent) {
      throw new Error('Invalid filename');
    }
    try {
      await fs.writeFile(full, '', { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`"${name}" already exists`);
      }
      throw err;
    }
    return full;
  });

  ipcMain.handle('fs:create-dir', async (_e, parent: string, name: string) => {
    const safeParent = sanitizeFsPath(parent, { mustExist: true });
    if (typeof name !== 'string' || name.length === 0 || /[\0/\\]/.test(name)) {
      throw new Error('Invalid folder name');
    }
    const full = sanitizeFsPath(path.join(safeParent, name));
    if (!full.startsWith(safeParent + path.sep) && full !== safeParent) {
      throw new Error('Invalid folder name');
    }
    await fs.mkdir(full, { recursive: false });
    return full;
  });

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
    const safeOld = sanitizeFsPath(oldPath, { mustExist: true });
    const safeNew = sanitizeFsPath(newPath);
    await fs.rename(safeOld, safeNew);
    return true;
  });

  ipcMain.handle('fs:remove', async (_e, target: string) => {
    const safe = sanitizeFsPath(target, { mustExist: true });
    const stat = await fs.lstat(safe);
    if (stat.isDirectory()) {
      await fs.rm(safe, { recursive: true, force: true });
    } else {
      await fs.unlink(safe);
    }
    return true;
  });

  ipcMain.handle('fs:reveal', async (_e, target: string) => {
    try {
      const safe = sanitizeFsPath(target, { mustExist: true });
      shell.showItemInFolder(safe);
      return true;
    } catch (err) {
      console.error('[fs:reveal]', err);
      return false;
    }
  });

  ipcMain.handle('update:check', async () => updateManager?.check() ?? null);
  ipcMain.handle('update:download-and-install', async () =>
    updateManager?.downloadAndInstall() ?? null,
  );

  // --- Terminal IPC ------------------------------------------------------
  //
  // We spawn real shell processes (no node-pty dependency to keep the
  // install portable — no native rebuild). Each session streams stdout
  // and stderr back to the renderer via IPC events keyed by session id.
  // Input from the user goes back through terminal:write.
  //
  // For agent-triggered commands that need to return a final result
  // string, we offer terminal:run-once which buffers the output to a
  // capped size and resolves with the combined log + exit code.

  interface Session {
    proc: ChildProcessWithoutNullStreams;
    cwd: string;
  }
  const sessions = new Map<string, Session>();

  const resolvePath = (maybePath: string | undefined): string => {
    const cwd = maybePath ?? process.cwd();
    return sanitizeFsPath(cwd, { mustExist: true });
  };

  const shellFor = (): { cmd: string; args: string[] } => {
    if (process.platform === 'win32') {
      return { cmd: process.env.COMSPEC ?? 'cmd.exe', args: [] };
    }
    return { cmd: process.env.SHELL ?? '/bin/bash', args: ['-i'] };
  };

  ipcMain.handle('terminal:spawn', (event, cwd?: string) => {
    const safe = resolvePath(cwd);
    const { cmd, args } = shellFor();
    const proc = spawn(cmd, args, {
      cwd: safe,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.set(id, { proc, cwd: safe });
    const sender = event.sender;
    const safeSend = (channel: string, payload: unknown) => {
      if (sender.isDestroyed()) return;
      try { sender.send(channel, payload); }
      catch { /* sender disposed mid-send; nothing to do */ }
    };
    proc.stdout.on('data', (chunk) => safeSend('terminal:data', { id, chunk: chunk.toString() }));
    proc.stderr.on('data', (chunk) => safeSend('terminal:data', { id, chunk: chunk.toString() }));
    proc.on('close', (code) => {
      sessions.delete(id);
      safeSend('terminal:exit', { id, code });
    });
    proc.on('error', (err) => {
      safeSend('terminal:data', { id, chunk: `\r\n[spawn error] ${err.message}\r\n` });
    });
    // If the renderer goes away (window close, reload), don't leak child shells.
    const onDestroyed = () => {
      try { proc.kill('SIGTERM'); } catch { /* */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 2000).unref();
      sessions.delete(id);
    };
    sender.once('destroyed', onDestroyed);
    proc.once('close', () => sender.removeListener('destroyed', onDestroyed));
    return { id, shell: cmd };
  });

  ipcMain.handle('terminal:write', (_e, id: string, data: string) => {
    // v0.13.8 — typeof guards. A malicious or buggy renderer could send
    // a non-string `data` (Buffer, null, object) which would crash the
    // child process or get serialised oddly. Return false on bad input
    // instead of throwing so the renderer sees a clean rejection.
    if (typeof id !== 'string' || id.length === 0) return false;
    if (typeof data !== 'string') return false;
    const s = sessions.get(id);
    if (!s) return false;
    try {
      s.proc.stdin.write(data);
    } catch {
      return false;
    }
    return true;
  });

  ipcMain.handle('terminal:resize', (_e, _id: string, _cols: number, _rows: number) => {
    // Without node-pty we can't resize the PTY; ignore. Log line-wrap
    // remains correct because the shell reads the effective COLUMNS
    // from the TTY it sees (none here) and falls back to the default.
    return true;
  });

  ipcMain.handle('terminal:kill', (_e, id: string) => {
    const s = sessions.get(id);
    if (!s) return false;
    s.proc.kill('SIGTERM');
    sessions.delete(id);
    return true;
  });

  /**
   * Fire-and-wait command execution for the agent. Buffers stdout+stderr
   * (capped) and resolves with `{stdout, exit_code, timed_out}` once the
   * process exits or the timeout fires.
   */
  ipcMain.handle(
    'terminal:run-once',
    (_e, input: { command: string; cwd?: string; timeout_ms?: number }) => {
      return new Promise((resolve) => {
        if (
          !input ||
          typeof input.command !== 'string' ||
          input.command.trim().length === 0
        ) {
          resolve({ stdout: '', exit_code: -1, error: 'empty command' });
          return;
        }
        const safeCwd = (() => {
          try { return resolvePath(input.cwd); }
          catch { return null; }
        })();
        if (!safeCwd) {
          resolve({ stdout: '', exit_code: -1, error: 'invalid cwd' });
          return;
        }
        const isWin = process.platform === 'win32';
        const cmd = isWin ? process.env.COMSPEC ?? 'cmd.exe' : '/bin/sh';
        const args = isWin ? ['/c', input.command] : ['-c', input.command];
        // Pager-safe env: tools like `git log` / `less` would normally
        // open a pager and hang waiting for keystrokes; PAGER=cat keeps
        // them streaming. Force NO_COLOR-friendly defaults too.
        const child = spawn(cmd, args, {
          cwd: safeCwd,
          env: {
            ...process.env,
            TERM: 'dumb',
            PAGER: 'cat',
            GIT_PAGER: 'cat',
            MANPAGER: 'cat',
            CI: '1',
            NODE_DISABLE_COLORS: '1',
          },
        });
        // v0.11.14: middle-truncation. The old strategy only kept
        // the head, so a failing test run with 10K stdout lines
        // dropped the actual error message buried at the end. We
        // now keep the first HEAD_CAP and the last TAIL_CAP chars
        // joined by a '... [N bytes truncated] ...' marker. Both
        // ends matter: the head usually carries setup/banner, the
        // tail carries the error / exit reason.
        const HEAD_CAP = 100_000;
        const TAIL_CAP = 100_000;
        const HARD_LIMIT = 5_000_000; // refuse to buffer more than 5 MB total
        let head = '';
        let tail = '';
        let truncatedBytes = 0;
        let timedOut = false;
        const rawTimeout =
          typeof input.timeout_ms === 'number' && Number.isFinite(input.timeout_ms)
            ? input.timeout_ms
            : 120_000;
        const timeoutMs = Math.min(Math.max(rawTimeout, 1000), 600_000);
        const timeout = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { /* */ }
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 2000).unref();
        }, timeoutMs);
        timeout.unref();
        const append = (s: string) => {
          // Phase 1: fill the head up to HEAD_CAP. Anything beyond
          // goes into the rolling tail.
          if (head.length < HEAD_CAP) {
            const need = HEAD_CAP - head.length;
            if (s.length <= need) {
              head += s;
              return;
            }
            head += s.slice(0, need);
            s = s.slice(need);
          }
          // Phase 2: append to tail; let it grow up to TAIL_CAP * 2
          // then drop the oldest half. This keeps the LAST TAIL_CAP
          // bytes always available with O(1) amortised cost.
          tail += s;
          if (tail.length > TAIL_CAP * 2) {
            const dropped = tail.length - TAIL_CAP;
            tail = tail.slice(dropped);
            truncatedBytes += dropped;
          }
          // Hard limit to prevent OOM on a runaway process emitting
          // gigabytes of output.
          if (head.length + tail.length + truncatedBytes > HARD_LIMIT) {
            try { child.kill('SIGTERM'); } catch { /* */ }
          }
        };
        const finalBuffer = (): string => {
          if (head.length < HEAD_CAP && tail.length === 0) return head;
          if (truncatedBytes === 0 && head.length + tail.length <= HEAD_CAP) {
            // Everything fit in the head — no marker needed.
            return head + tail;
          }
          const droppedNote = truncatedBytes > 0
            ? `\n... [${truncatedBytes.toLocaleString()} bytes truncated in the middle] ...\n`
            : '\n... [output split: head + tail kept] ...\n';
          return head + droppedNote + tail;
        };
        child.stdout.on('data', (c) => append(c.toString()));
        child.stderr.on('data', (c) => append(c.toString()));
        child.on('close', (code) => {
          clearTimeout(timeout);
          resolve({
            stdout: finalBuffer(),
            exit_code: typeof code === 'number' ? code : -1,
            timed_out: timedOut,
          });
        });
        child.on('error', (err) => {
          clearTimeout(timeout);
          resolve({ stdout: finalBuffer(), exit_code: -1, error: err.message });
        });
      });
    },
  );

  // ---- Codebase search (grep) --------------------------------------
  // Powers the agent's `grep` and `codebase_search` tools. Tries
  // `rg` (ripgrep) first when available — fast on big repos. Falls
  // back to a Node walk that respects .gitignore + a built-in
  // ignore list when ripgrep isn't on the PATH (Windows users
  // without scoop/choco). Returns a capped list of {path, line, text}
  // hits so the model gets enough context to decide what to read
  // next without being drowned in 10 000 matches.
  ipcMain.handle(
    'search:grep',
    async (
      _e,
      input: {
        pattern: string;
        cwd: string;
        /** Glob to restrict the search (e.g. "**\/*.ts"). Optional. */
        glob?: string;
        /** Max number of matches to return (caller-side cap). */
        max_results?: number;
        case_sensitive?: boolean;
      },
    ) => {
      if (!input || typeof input.pattern !== 'string' || input.pattern.length === 0) {
        return { error: 'pattern required', hits: [] };
      }
      const safeCwd = sanitizeFsPath(input.cwd, { mustExist: true });
      const limit = Math.min(Math.max(input.max_results ?? 100, 1), 500);
      const args = [
        '--json',
        '--max-count', '20',
        '--max-columns', '400',
        '--max-filesize', '5M',
        '--no-messages',
      ];
      if (!input.case_sensitive) args.push('--ignore-case');
      if (input.glob) {
        args.push('--glob', input.glob);
      }
      args.push(input.pattern, '.');
      const hits: { path: string; line: number; text: string }[] = [];
      const rgError: { code?: number; msg?: string } = {};
      try {
        await new Promise<void>((resolve) => {
          const child = spawn('rg', args, { cwd: safeCwd });
          let buf = '';
          child.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                if (ev.type === 'match' && hits.length < limit) {
                  const data = ev.data;
                  hits.push({
                    path: data.path?.text ?? '?',
                    line: data.line_number ?? 0,
                    text: (data.lines?.text ?? '').replace(/\n+$/, ''),
                  });
                  if (hits.length >= limit) child.kill();
                }
              } catch { /* malformed JSON line — ignore */ }
            }
          });
          child.on('error', (err) => {
            rgError.msg = err.message;
            resolve();
          });
          child.on('close', (code) => {
            if (typeof code === 'number') rgError.code = code;
            resolve();
          });
        });
        if (hits.length > 0) return { hits, source: 'ripgrep' };
        // ripgrep not installed (ENOENT) → fall back to Node grep.
      } catch (err) {
        rgError.msg = (err as Error).message;
      }
      // Node fallback. Slow on big trees but always available.
      const nodeHits = await nodeGrep(safeCwd, input.pattern, {
        caseSensitive: input.case_sensitive ?? false,
        glob: input.glob,
        limit,
      });
      return { hits: nodeHits, source: 'node-fallback', rgError };
    },
  );

  // v0.15.4 — git status badges for the sidebar. Spawns `git` twice :
  //   1) `git rev-parse --show-toplevel` to find the repo root (the
  //      workspace can be a sub-directory of the repo).
  //   2) `git status --porcelain=v1 -z -uall --no-renames` to list
  //      every dirty path. -z is NUL-separated so spaces / unicode
  //      paths parse without quoting headaches.
  // Returns absolute paths keyed in `statuses` so the renderer can
  // match without further normalisation. If `git` isn't on PATH, the
  // workspace isn't a repo, or anything fails → returns ok:false and
  // the sidebar simply skips badges.
  // v0.15.5 (audit #1, #2, #3, #8, #12) :
  //   - per-spawn timeout (8s) — prevents NFS / huge-repo hangs
  //   - stdout buffer cap (32 MB) — kills the child if exceeded
  //   - sanitizeFsPath on the rev-parse output before joining
  //   - reject paths with `..` segments or absolute `/` prefix
  //   - propagate stderr on rev-parse failure (not_a_repo vs no-git)
  const GIT_SPAWN_TIMEOUT_MS = 8_000;
  const GIT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
  ipcMain.handle('git:status', async (_e, input: { cwd: string }) => {
    let safeCwd: string;
    try {
      safeCwd = sanitizeFsPath(input?.cwd, { mustExist: true });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const runGit = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
      new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const settle = (r: { code: number; stdout: string; stderr: string }) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        let child: ChildProcessWithoutNullStreams;
        try {
          child = spawn('git', args, { cwd: safeCwd });
        } catch (err) {
          settle({ code: -1, stdout: '', stderr: (err as Error).message });
          return;
        }
        const killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          settle({ code: -1, stdout, stderr: stderr + '\n[timeout]' });
        }, GIT_SPAWN_TIMEOUT_MS);
        child.stdout.on('data', (c) => {
          stdout += c.toString();
          if (stdout.length > GIT_MAX_STDOUT_BYTES) {
            try { child.kill('SIGKILL'); } catch { /* */ }
            clearTimeout(killTimer);
            settle({ code: -1, stdout, stderr: stderr + '\n[output_too_large]' });
          }
        });
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('error', (err) => {
          clearTimeout(killTimer);
          settle({ code: -1, stdout, stderr: stderr + err.message });
        });
        child.on('close', (code) => {
          clearTimeout(killTimer);
          settle({ code: code ?? -1, stdout, stderr });
        });
      });
    const toplevel = await runGit(['rev-parse', '--show-toplevel']);
    if (toplevel.code !== 0) {
      return { ok: false, error: toplevel.stderr.trim() || 'not_a_git_repo' };
    }
    let root: string;
    try {
      // Re-validate the repo root through sanitizeFsPath so a symlinked
      // toplevel that escapes FS_DENY can't sneak through.
      root = sanitizeFsPath(toplevel.stdout.trim(), { mustExist: true });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (!root) return { ok: false, error: 'not_a_git_repo' };
    const status = await runGit([
      '-c', 'core.quotepath=false',
      'status', '--porcelain=v1', '-z', '-uall', '--no-renames',
    ]);
    if (status.code !== 0) {
      return { ok: false, error: status.stderr.trim() || 'git_status_failed' };
    }
    const statuses: Record<string, string> = {};
    let count = 0;
    // -z output: each entry is `XY <space> <path>\0`. Split on NUL,
    // drop the trailing empty entry.
    const entries = status.stdout.split('\0').filter((e) => e.length > 0);
    for (const entry of entries) {
      if (count >= 5000) break;
      if (entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      // Skip the space at index 2.
      const rel = entry.slice(3);
      // Defensive: refuse traversal segments / absolute paths from git
      // output (would only happen on a broken repo or a hostile
      // submodule, but the cost of the check is zero).
      if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) continue;
      // Pick the most-meaningful char :
      //   - '?' (untracked) wins over anything (X='?' Y='?')
      //   - conflict markers ('U', 'A' on both sides, etc.) → 'C'
      //   - else worktree change Y, falling back to index change X
      let code: string;
      if (x === '?' || y === '?') code = 'U';        // untracked
      else if (x === '!' || y === '!') continue;       // ignored — skip
      else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
        code = 'C';                                   // conflict
      } else if (y !== ' ' && y !== '') code = y;     // worktree change
      else if (x !== ' ' && x !== '') code = x;       // staged-only change
      else continue;
      // Normalise to forward slashes + NFC so the renderer can match
      // against fs:read-dir output regardless of platform/Unicode form.
      const abs = path.join(root, rel).replace(/\\/g, '/').normalize('NFC');
      statuses[abs] = code;
      count++;
    }
    return { ok: true, root: root.replace(/\\/g, '/').normalize('NFC'), statuses };
  });
}

/**
 * Minimal recursive grep used when ripgrep isn't on PATH. Skips
 * ignore-listed dirs (node_modules, .git, dist…) and large files.
 * Not as fast as rg, but ships zero deps and works everywhere.
 */
async function nodeGrep(
  root: string,
  pattern: string,
  opts: { caseSensitive: boolean; glob?: string; limit: number },
): Promise<{ path: string; line: number; text: string }[]> {
  const NOISY = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron',
    'build', 'release', '.next', '.cache', '.turbo', '.parcel-cache',
    '.idea', '.vscode', 'coverage', '__pycache__', '.venv', 'venv',
    'target',
  ]);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, opts.caseSensitive ? '' : 'i');
  } catch {
    // Treat unparseable input as a literal substring search.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, opts.caseSensitive ? '' : 'i');
  }
  // Glob support is intentionally minimal — we only honour a trailing
  // extension filter ("**\/*.ts" → /\.ts$/) since that's the common
  // case. Anything fancier would need a full glob library.
  let extensionFilter: RegExp | null = null;
  if (opts.glob) {
    const m = opts.glob.match(/\.([a-zA-Z0-9_]+)$/);
    if (m) extensionFilter = new RegExp(`\\.${m[1]}$`);
  }
  const hits: { path: string; line: number; text: string }[] = [];
  async function walk(dir: string): Promise<void> {
    if (hits.length >= opts.limit) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (hits.length >= opts.limit) return;
      if (NOISY.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        if (extensionFilter && !extensionFilter.test(e.name)) continue;
        let stat;
        try { stat = await fs.stat(abs); } catch { continue; }
        if (stat.size > 5_000_000) continue; // skip files > 5MB
        let content: string;
        try { content = await fs.readFile(abs, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= opts.limit) return;
          if (regex.test(lines[i])) {
            hits.push({
              path: abs,
              line: i + 1,
              text: lines[i].slice(0, 400),
            });
          }
        }
      }
    }
  }
  await walk(root);
  return hits;
}

app.whenReady().then(() => {
  // v0.12.5 (audit #2): in production, install a strict CSP via the
  // response-headers hook that overrides whatever the renderer's
  // <meta http-equiv="Content-Security-Policy"> said. We can't drop
  // 'unsafe-inline' from script-src in dev because Vite's HMR client
  // is injected as inline script — but in the packaged build there
  // are no inline scripts, so we kill the directive entirely.
  // Style-src keeps 'unsafe-inline' because Monaco emits ad-hoc
  // <style> elements at runtime that we cannot nonce.
  if (app.isPackaged) {
    const STRICT_CSP = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: http://localhost:* ws://localhost:*",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // Only inject CSP on document loads — adding it to script /
      // stylesheet / image / SSE responses is wasted bytes and could
      // confuse devtools when inspecting non-document responses.
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      const headers = { ...(details.responseHeaders ?? {}) };
      // Drop any CSP the loaded document set so ours is authoritative.
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'content-security-policy') {
          delete headers[k];
        }
      }
      headers['Content-Security-Policy'] = [STRICT_CSP];
      callback({ responseHeaders: headers });
    });
  }

  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    // Defend against directory traversal (e.g. /../../etc/passwd).
    const requested = path.normalize(path.join(RENDERER_DIST, url.pathname));
    const rootWithSep = RENDERER_DIST.endsWith(path.sep)
      ? RENDERER_DIST
      : RENDERER_DIST + path.sep;
    if (requested !== RENDERER_DIST && !requested.startsWith(rootWithSep)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      return new Response(await fs.readFile(requested));
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  createWindow();

  updateManager = new UpdateManager({
    manifestUrl:
      process.env.UPDATE_MANIFEST_URL ??
      'https://suxai.209-99-186-238.sslip.io/update/manifest',
    currentVersion: app.getVersion(),
    getWindow: () => mainWindow,
  });

  // Best-effort check after launch; non-blocking.
  setTimeout(() => {
    updateManager?.check().catch((err) => console.warn('[update] check failed:', err));
  }, 3000);

  // Re-check every hour in case the user keeps the app running.
  setInterval(() => {
    updateManager?.check().catch(() => {});
  }, 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return;
    // v0.12.1 (audit #14): only hand http(s) and mailto links off to
    // the system. Anything else (file:, chrome:, javascript:, custom
    // schemes that shell handlers might honour) is silently denied —
    // a malicious markdown anchor in chat output cannot escape the
    // app via will-navigate anymore.
    event.preventDefault();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const allowed = parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
    if (allowed) shell.openExternal(url);
  });
  // v0.12.1 (audit #14): same allowlist when any web contents in the
  // app tries to spawn a new window. We never want a popup; routing
  // safe URLs to the OS browser is the documented Electron pattern.
  contents.setWindowOpenHandler(({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      shell.openExternal(url).catch(() => { /* */ });
    }
    return { action: 'deny' };
  });
});
