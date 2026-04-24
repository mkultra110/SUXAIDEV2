import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
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
    return parsed as UserRecord[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(users: UserRecord[]): Promise<void> {
  await ensureDataDir();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fs.rename(tmp, DB_FILE);
}

export const userStore = {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const users = await readAll();
    return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
  },

  async findById(id: string): Promise<UserRecord | null> {
    const users = await readAll();
    return users.find((u) => u.id === id) ?? null;
  },

  async create(input: { email: string; passwordHash: string }): Promise<UserRecord> {
    let created!: UserRecord;
    await enqueueWrite(async () => {
      const users = await readAll();
      if (users.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
        throw Object.assign(new Error('Email already registered'), { status: 409, code: 'EMAIL_IN_USE' });
      }
      const now = new Date().toISOString();
      created = {
        id: crypto.randomUUID(),
        email: input.email,
        passwordHash: input.passwordHash,
        createdAt: now,
        updatedAt: now,
      };
      await writeAll([...users, created]);
    });
    return created;
  },
};
