import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export type UserTier = 'free' | 'pro';

export interface UserRecord {
  id: string;
  username: string;
  /** Legacy field — still stored for records created before usernames
   *  were required, but no longer collected or displayed. Empty for new
   *  registrations. */
  email?: string;
  passwordHash: string;
  tier: UserTier;
  // Daily AI usage — cumulative wall time spent streaming (ms) for the
  // given date (YYYY-MM-DD). Resets on a new day.
  dailyUsageMs: number;
  dailyUsageDate: string;
  createdAt: string;
  updatedAt: string;
}

const DB_FILE = path.join(env.DATA_DIR, 'users.json');

type WriteFn = () => Promise<void>;
let writeQueue: Promise<void> = Promise.resolve();
function enqueueWrite(fn: WriteFn): Promise<void> {
  writeQueue = writeQueue.then(fn, fn);
  return writeQueue;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(env.DATA_DIR, { recursive: true });
}

async function readAll(): Promise<UserRecord[]> {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Backfill any fields added after user creation so older records keep
    // working without a separate migration step.
    return (parsed as Partial<UserRecord>[]).map((u) => ({
      id: u.id ?? crypto.randomUUID(),
      username: u.username ?? (u.email ? u.email.split('@')[0] : 'user'),
      email: u.email,
      passwordHash: u.passwordHash ?? '',
      tier: (u.tier as UserTier) ?? 'free',
      dailyUsageMs: typeof u.dailyUsageMs === 'number' ? u.dailyUsageMs : 0,
      dailyUsageDate: u.dailyUsageDate ?? '',
      createdAt: u.createdAt ?? new Date().toISOString(),
      updatedAt: u.updatedAt ?? new Date().toISOString(),
    })) as UserRecord[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(users: UserRecord[]): Promise<void> {
  await ensureDataDir();
  const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  // Open with explicit mode so we can fsync before rename. A power
  // loss between writeFile and rename would otherwise lose every
  // user in users.json — including the credentials of anyone who
  // just registered.
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(JSON.stringify(users, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, DB_FILE);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export const userStore = {
  async findByUsername(username: string): Promise<UserRecord | null> {
    const users = await readAll();
    return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) ?? null;
  },

  async findById(id: string): Promise<UserRecord | null> {
    const users = await readAll();
    return users.find((u) => u.id === id) ?? null;
  },

  async create(input: {
    username: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    let created!: UserRecord;
    await enqueueWrite(async () => {
      const users = await readAll();
      if (users.some((u) => u.username.toLowerCase() === input.username.toLowerCase())) {
        throw Object.assign(new Error('Username already taken'), {
          status: 409,
          code: 'USERNAME_IN_USE',
        });
      }
      const now = new Date().toISOString();
      created = {
        id: crypto.randomUUID(),
        username: input.username,
        passwordHash: input.passwordHash,
        tier: 'free',
        dailyUsageMs: 0,
        dailyUsageDate: '',
        createdAt: now,
        updatedAt: now,
      };
      await writeAll([...users, created]);
    });
    return created;
  },

  async setTier(userId: string, tier: UserTier): Promise<UserRecord | null> {
    let updated: UserRecord | null = null;
    await enqueueWrite(async () => {
      const users = await readAll();
      const idx = users.findIndex((u) => u.id === userId);
      if (idx < 0) return;
      users[idx] = { ...users[idx], tier, updatedAt: new Date().toISOString() };
      updated = users[idx];
      await writeAll(users);
    });
    return updated;
  },

  /**
   * Add `deltaMs` to the user's daily usage counter. Resets if the stored
   * date is not today. Returns the updated counter + tier so the caller
   * can decide whether to block.
   */
  async trackUsage(
    userId: string,
    deltaMs: number,
  ): Promise<{ tier: UserTier; usedMs: number } | null> {
    if (deltaMs < 0) deltaMs = 0;
    let result: { tier: UserTier; usedMs: number } | null = null;
    await enqueueWrite(async () => {
      const users = await readAll();
      const idx = users.findIndex((u) => u.id === userId);
      if (idx < 0) return;
      const today = todayUtc();
      const base = users[idx].dailyUsageDate === today ? users[idx].dailyUsageMs : 0;
      const usedMs = base + deltaMs;
      users[idx] = {
        ...users[idx],
        dailyUsageMs: usedMs,
        dailyUsageDate: today,
        updatedAt: new Date().toISOString(),
      };
      result = { tier: users[idx].tier, usedMs };
      await writeAll(users);
    });
    return result;
  },

  /**
   * Current usage for today (ms). 0 if not yet used today.
   *
   * Routed through the write queue so a quota-check that arrives
   * while a trackUsage write is in flight reads the post-write state.
   * Without this, two simultaneous AI requests can both check usage,
   * both see "under quota", and both get to stream — letting a free-
   * tier user briefly burn 2× their daily budget.
   */
  async getDailyUsage(userId: string): Promise<{ tier: UserTier; usedMs: number }> {
    let result: { tier: UserTier; usedMs: number } = { tier: 'free', usedMs: 0 };
    await enqueueWrite(async () => {
      const users = await readAll();
      const user = users.find((u) => u.id === userId);
      if (!user) return;
      const today = todayUtc();
      result = {
        tier: user.tier,
        usedMs: user.dailyUsageDate === today ? user.dailyUsageMs : 0,
      };
    });
    return result;
  },
};
