import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { UpdateManager } from './updater';

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
    try {
      const raw = await fs.readFile(CONVERSATIONS_FILE(), 'utf8');
      // Forward the raw parsed value — caller decides legacy vs current
      // shape.
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
  ipcMain.handle('conv:write', async (_e, data: unknown) => {
    // Accept any JSON-serialisable payload — the old contract was
    // \"array of messages\", the new one is { version, active, list }.
    if (data === null || data === undefined) {
      throw new Error('Conversations payload required');
    }
    await fs.mkdir(USER_DATA(), { recursive: true });
    const tmp = `${CONVERSATIONS_FILE()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
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
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      path: path.join(dirPath, e.name),
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

  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string) => {
    const safe = sanitizeFsPath(filePath);
    if (typeof content !== 'string') throw new Error('Content must be a string');
    await fs.writeFile(safe, content, 'utf8');
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
    await fs.writeFile(safe, content, 'utf8');
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
    proc.stdout.on('data', (chunk) => {
      if (!sender.isDestroyed()) sender.send('terminal:data', { id, chunk: chunk.toString() });
    });
    proc.stderr.on('data', (chunk) => {
      if (!sender.isDestroyed()) sender.send('terminal:data', { id, chunk: chunk.toString() });
    });
    proc.on('close', (code) => {
      sessions.delete(id);
      if (!sender.isDestroyed()) sender.send('terminal:exit', { id, code });
    });
    proc.on('error', (err) => {
      if (!sender.isDestroyed()) {
        sender.send('terminal:data', { id, chunk: `\r\n[spawn error] ${err.message}\r\n` });
      }
    });
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
        if (!input || typeof input.command !== 'string' || input.command.trim() === '') {
          resolve({ stdout: '', exit_code: -1, error: 'empty command' });
          return;
        }
        const safeCwd = (() => {
          try { return resolvePath(input.cwd); }
          catch (err) { return null; }
        })();
        if (!safeCwd) {
          resolve({ stdout: '', exit_code: -1, error: 'invalid cwd' });
          return;
        }
        const isWin = process.platform === 'win32';
        const cmd = isWin ? process.env.COMSPEC ?? 'cmd.exe' : '/bin/sh';
        const args = isWin ? ['/c', input.command] : ['-c', input.command];
        const child = spawn(cmd, args, {
          cwd: safeCwd,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
        const CAP = 200_000;
        let buf = '';
        let timedOut = false;
        const timeout = setTimeout(
          () => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 2000);
          },
          Math.min(Math.max(input.timeout_ms ?? 120_000, 1000), 600_000),
        );
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
