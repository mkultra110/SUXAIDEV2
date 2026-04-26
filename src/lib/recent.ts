import { useEffect, useState } from 'react';

/**
 * Recently opened files. Persisted in localStorage, capped at MAX
 * entries, deduped on path (most-recent open wins). Exposed as a
 * tiny lib + a React hook so any component can read or react to
 * changes without re-prop-drilling through WorkspaceContext.
 */

export interface RecentFile {
  path: string;
  name: string;
  /** Workspace root at time of opening — for grouping in UI. */
  workspace?: string;
  ts: number;
}

const KEY = 'suxai.recent.v1';
const MAX = 50;
const EVENT = 'suxai:recent';

function load(): RecentFile[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape filter — anything malformed (older format,
    // tampered, partial write) is silently dropped.
    return parsed
      .filter(
        (e): e is RecentFile =>
          e &&
          typeof e.path === 'string' &&
          typeof e.name === 'string' &&
          typeof e.ts === 'number',
      )
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function persist(list: RecentFile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent<RecentFile[]>(EVENT, { detail: list }));
  } catch {
    /* quota exceeded or storage disabled — silently drop */
  }
}

export function pushRecent(file: { path: string; name: string; workspace?: string }): void {
  // Skip untitled buffers — they have no real on-disk path.
  if (!file.path || file.path.startsWith('untitled://')) return;
  const current = load();
  const filtered = current.filter((e) => e.path !== file.path);
  filtered.unshift({
    path: file.path,
    name: file.name,
    workspace: file.workspace,
    ts: Date.now(),
  });
  persist(filtered.slice(0, MAX));
}

export function getRecent(): RecentFile[] {
  return load();
}

export function clearRecent(): void {
  persist([]);
}

export function removeRecent(path: string): void {
  const filtered = load().filter((e) => e.path !== path);
  persist(filtered);
}

/**
 * v0.13.16 (audit #10) — helper for callers that want to drop a
 * recent entry only when the file is genuinely gone (ENOENT / "does
 * not exist"). A transient permission error or read-failure during
 * a save shouldn't cost the user their recent-list entry.
 *
 * Electron's IPC serialises errors as plain Error objects so the
 * Node `code` property is lost — we sniff the message instead.
 */
export function removeRecentIfMissing(path: string, err: unknown): void {
  const msg = String((err as Error)?.message ?? err);
  if (
    msg.includes('does not exist') ||
    msg.includes('ENOENT') ||
    msg.includes('no such file')
  ) {
    removeRecent(path);
  }
}

/** React hook — returns the live list, auto-rerendering on push/clear. */
export function useRecent(): RecentFile[] {
  const [list, setList] = useState<RecentFile[]>(load);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RecentFile[]>).detail;
      if (Array.isArray(detail)) setList(detail);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
  return list;
}
