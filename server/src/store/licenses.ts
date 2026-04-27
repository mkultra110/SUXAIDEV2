import fs from 'node:fs/promises';
import path from 'node:path';
import crypto, { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * v0.15.10 (audit-4 #8) — constant-time string compare so an
 * attacker can't time-side-channel which licenses exist. The schema
 * already enforces a fixed format (SUXAI-XXXX-XXXX-XXXX),
 * so all valid keys are the same byte length — perfect fit for
 * timingSafeEqual which throws on length mismatch.
 */
function keysEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface LicenseRecord {
  key: string;
  tier: 'pro';
  createdAt: string;
  redeemedBy?: string;  // userId
  redeemedAt?: string;
  note?: string;
}

const DB_FILE = path.join(env.DATA_DIR, 'licenses.json');

let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(fn, fn);
  return writeQueue;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(env.DATA_DIR, { recursive: true });
}

async function readAll(): Promise<LicenseRecord[]> {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LicenseRecord[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(records: LicenseRecord[]): Promise<void> {
  await ensureDataDir();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  // v0.15.10 (audit-4 #3) — open/write/fsync/close/rename so a power
  // loss between the writeFile and the rename can't lose redeemed-state.
  // Without fsync the kernel may buffer the write and the rename
  // commits before the contents reach disk → on reboot the license
  // looks unredeemed and can be replayed.
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(records, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, DB_FILE);
}

function generateKey(): string {
  // 3×4-char blocks: SUXAI-XXXX-XXXX-XXXX (60 bits entropy, no modular bias)
  const bytes = crypto.randomBytes(12);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no 0/O/1/I
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return `SUXAI-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export const licenseStore = {
  async create(note?: string): Promise<LicenseRecord> {
    let created!: LicenseRecord;
    await enqueueWrite(async () => {
      const records = await readAll();
      let key: string;
      do {
        key = generateKey();
      } while (records.some((r) => keysEqual(r.key, key)));
      created = { key, tier: 'pro', createdAt: new Date().toISOString(), note };
      await writeAll([...records, created]);
    });
    return created;
  },

  async findByKey(key: string): Promise<LicenseRecord | null> {
    const records = await readAll();
    return records.find((r) => keysEqual(r.key, key)) ?? null;
  },

  async redeem(key: string, userId: string): Promise<LicenseRecord | null> {
    let updated: LicenseRecord | null = null;
    let alreadyRedeemed = false;
    await enqueueWrite(async () => {
      const records = await readAll();
      const idx = records.findIndex((r) => keysEqual(r.key, key));
      if (idx < 0) return;
      if (records[idx].redeemedBy) {
        alreadyRedeemed = true;
        return;
      }
      records[idx] = {
        ...records[idx],
        redeemedBy: userId,
        redeemedAt: new Date().toISOString(),
      };
      updated = records[idx];
      await writeAll(records);
    });
    if (alreadyRedeemed) {
      throw Object.assign(new Error('License already redeemed'), {
        status: 409,
        code: 'ALREADY_REDEEMED',
      });
    }
    return updated;
  },

  async list(): Promise<LicenseRecord[]> {
    return readAll();
  },
};
