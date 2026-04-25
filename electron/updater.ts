import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';

type Manifest = {
  version: string;
  url: string;
  notes?: string;
  sha256?: string;
  size?: number;
  releasedAt?: string;
};

type CheckResult =
  | { available: false; currentVersion: string }
  | {
      available: true;
      currentVersion: string;
      version: string;
      notes?: string;
      url: string;
      sha256?: string;
    };

export interface UpdateManagerOptions {
  manifestUrl: string;
  currentVersion: string;
  getWindow: () => BrowserWindow | null;
}

export class UpdateManager {
  private manifest: Manifest | null = null;
  constructor(private opts: UpdateManagerOptions) {}

  async check(): Promise<CheckResult> {
    const manifest = await this.fetchJson<Manifest>(this.opts.manifestUrl);
    this.manifest = manifest;
    const isNewer = compareSemver(manifest.version, this.opts.currentVersion) > 0;
    if (!isNewer) {
      return { available: false, currentVersion: this.opts.currentVersion };
    }
    return {
      available: true,
      currentVersion: this.opts.currentVersion,
      version: manifest.version,
      notes: manifest.notes,
      url: manifest.url,
      sha256: manifest.sha256,
    };
  }

  async downloadAndInstall(): Promise<boolean> {
    if (!this.manifest) {
      await this.check();
    }
    if (!this.manifest) throw new Error('No manifest loaded');

    const { url, sha256, size } = this.manifest;
    this.emitStatus('downloading');

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'suxai-update-'));
    const fileName = path.basename(new URL(url).pathname) || 'suxai-installer';
    const destPath = path.join(tmpDir, fileName);

    const maxAttempts = 4;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.downloadWithProgress(url, destPath, size);
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[update] download attempt ${attempt} failed:`, err);
        if (attempt === maxAttempts) {
          this.emitStatus('failed');
          throw err;
        }
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    if (lastErr && !fs.existsSync(destPath)) throw lastErr;

    if (sha256) {
      this.emitStatus('verifying');
      const actual = await sha256OfFile(destPath);
      if (actual.toLowerCase() !== sha256.toLowerCase()) {
        this.emitStatus('failed');
        // Delete the corrupt download so the next attempt starts
        // clean and we don't accumulate junk in the temp dir.
        fs.unlink(destPath, () => { /* best-effort */ });
        throw new Error(`Checksum mismatch: expected ${sha256}, got ${actual}`);
      }
    }

    this.emitStatus('ready');

    const result = await shell.openPath(destPath);
    if (result) {
      console.error('[update] failed to open installer:', result);
      this.emitStatus('failed');
      throw new Error(result);
    }

    setTimeout(() => app.quit(), 500);
    return true;
  }

  private downloadWithProgress(url: string, destPath: string, expectedSize?: number) {
    return new Promise<void>((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(destPath);
      let transferred = 0;
      const req = client.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(destPath, () => {});
          this.downloadWithProgress(res.headers.location, destPath, expectedSize).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = expectedSize ?? Number(res.headers['content-length'] ?? 0);
        res.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
          if (total > 0) {
            this.emitProgress({ percent: transferred / total, transferred, total });
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (err) => {
          file.close();
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });
      req.on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
      req.setTimeout(60_000, () => req.destroy(new Error('Request timed out')));
    });
  }

  private fetchJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.fetchJson<T>(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => req.destroy(new Error('Request timed out')));
    });
  }

  private emitProgress(payload: { percent: number; transferred: number; total: number }) {
    this.opts.getWindow()?.webContents.send('update:progress', payload);
  }

  private emitStatus(status: string) {
    this.opts.getWindow()?.webContents.send('update:status', status);
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
