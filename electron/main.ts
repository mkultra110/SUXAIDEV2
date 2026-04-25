import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol } from 'electron';
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
    return normalized;
  }

  ipcMain.handle('fs:read-file', async (_e, filePath: string) => {
    const safe = sanitizeFsPath(filePath, { mustExist: true });
    const content = await fs.readFile(safe, 'utf8');
    return { path: safe, content };
  });

  // Shared helper: atomic write (tmp + fsync + rename) with EXDEV
  // fallback. Reused by fs:write-file and fs:save-as so user-initiated
  // saves and agent-initiated saves get the same durability guarantees.
  async function atomicWrite(safe: string, content: string): Promise<void> {
    const tmp = `${safe}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(content, 'utf8');
        await fh.sync(); // flush page cache to disk before rename
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, safe);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* */ }
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        const fh = await fs.open(safe, 'w');
        try {
          await fh.writeFile(content, 'utf8');
          await fh.sync();
        } finally {
          await fh.close();
        }
        return;
      }
      throw err;
    }
  }

  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string) => {
    const safe = sanitizeFsPath(filePath);
    if (typeof content !== 'string') throw new Error('Content must be a string');
    await atomicWrite(safe, content);
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
    const s = sessions.get(id);
    if (!s) return false;
    s.proc.stdin.write(data);
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
        const CAP = 200_000;
        let buf = '';
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
          if (buf.length >= CAP) return;
          buf += s;
          if (buf.length > CAP) buf = buf.slice(0, CAP) + `\n[truncated — output exceeded ${CAP} chars]`;
        };
        child.stdout.on('data', (c) => append(c.toString()));
        child.stderr.on('data', (c) => append(c.toString()));
        child.on('close', (code) => {
          clearTimeout(timeout);
          resolve({
            stdout: buf,
            exit_code: typeof code === 'number' ? code : -1,
            timed_out: timedOut,
          });
        });
        child.on('error', (err) => {
          clearTimeout(timeout);
          resolve({ stdout: buf, exit_code: -1, error: err.message });
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
    event.preventDefault();
    shell.openExternal(url);
  });
});
