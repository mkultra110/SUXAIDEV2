import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { UpdateManager } from './updater';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.APP_ROOT = path.join(__dirname, '..');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST;

const USER_DATA = () => app.getPath('userData');
const TOKEN_FILE = () => path.join(USER_DATA(), 'auth.bin');

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

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
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

function registerIpc() {
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

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize-toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

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

  ipcMain.handle('fs:read-file', async (_e, filePath: string) => {
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  });

  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string) => {
    await fs.writeFile(filePath, content, 'utf8');
    return true;
  });

  ipcMain.handle('update:check', async () => updateManager?.check() ?? null);
  ipcMain.handle('update:download-and-install', async () =>
    updateManager?.downloadAndInstall() ?? null,
  );
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const filePath = path.join(RENDERER_DIST, url.pathname);
    return new Response(await fs.readFile(filePath));
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
