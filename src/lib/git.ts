import { useEffect, useState } from 'react';

/**
 * Workspace-scoped git status, polled on demand and refreshed on
 * file save / diff accept events. Single source of truth for the
 * sidebar M/U/D/C/A badges.
 *
 * Design choices :
 *   - Module-level cache keyed on workspaceRoot. Multiple sidebar
 *     instances share the same fetch + listen to the same refresh
 *     events, so we never run `git status` twice for the same root.
 *   - Refresh is event-driven : the renderer dispatches
 *     'suxai:git-refresh' after Save / agent edit / drag-drop. The
 *     hook also runs once on mount.
 *   - Failures (no git, not a repo) are cached as an empty map so
 *     we don't keep retrying every 200 ms — invalidate via clearGitCache().
 */

export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'R' | 'C';

interface CacheEntry {
  fetchedAt: number;
  /** Absolute path → status code. Empty when the workspace isn't a repo. */
  statuses: Record<string, GitStatusCode>;
  /** Repo toplevel — populated only when ok. */
  root: string | null;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();
const REFRESH_EVENT = 'suxai:git-refresh';

// v0.15.5 (audit #6) — generation counter per cwd. invalidateGitStatus
// bumps the counter so any in-flight fetch whose generation doesn't
// match the current one will NOT write back to the cache. Without this
// guard, an invalidate that fires while a fetch is in-flight repopulates
// the cache with the stale (pre-invalidate) result.
const generation = new Map<string, number>();

function bumpGeneration(cwd: string): number {
  const next = (generation.get(cwd) ?? 0) + 1;
  generation.set(cwd, next);
  return next;
}

function isStatusCode(c: string): c is GitStatusCode {
  return c === 'M' || c === 'A' || c === 'D' || c === 'U' || c === 'R' || c === 'C';
}

/** v0.15.5 — same normalisation the IPC handler applies. Used on the
 *  renderer side too so caller-supplied paths match the cache keys. */
export function normalizeGitPath(p: string): string {
  return p.replace(/\\/g, '/').normalize('NFC');
}

async function fetchStatus(cwd: string): Promise<CacheEntry> {
  const existing = inflight.get(cwd);
  if (existing) return existing;
  // Snapshot the generation at fetch start. If invalidateGitStatus runs
  // before this promise resolves, the stamped generation will no longer
  // match `generation.get(cwd)` and we skip the cache.set.
  const gen = generation.get(cwd) ?? 0;
  const promise = (async () => {
    if (!window.suxai?.git?.status) {
      return { fetchedAt: Date.now(), statuses: {}, root: null };
    }
    try {
      const res = await window.suxai.git.status({ cwd });
      if (!res.ok) {
        return { fetchedAt: Date.now(), statuses: {}, root: null };
      }
      const filtered: Record<string, GitStatusCode> = {};
      for (const [p, code] of Object.entries(res.statuses)) {
        if (isStatusCode(code)) filtered[normalizeGitPath(p)] = code;
      }
      return { fetchedAt: Date.now(), statuses: filtered, root: res.root };
    } catch {
      return { fetchedAt: Date.now(), statuses: {}, root: null };
    }
  })();
  inflight.set(cwd, promise);
  try {
    const entry = await promise;
    // Only commit to cache if our generation is still current (no
    // invalidate fired while we were in-flight).
    if ((generation.get(cwd) ?? 0) === gen) {
      cache.set(cwd, entry);
    }
    return entry;
  } finally {
    inflight.delete(cwd);
  }
}

/** Force the next call to refetch — invoked after Save / diff accept. */
export function invalidateGitStatus(cwd?: string): void {
  if (cwd) {
    cache.delete(cwd);
    bumpGeneration(cwd);
  } else {
    cache.clear();
    for (const k of generation.keys()) bumpGeneration(k);
  }
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: cwd ?? null }));
}

/** React hook : returns the current map for the workspace, refetches
 *  on mount + on every 'suxai:git-refresh' broadcast. */
export function useGitStatus(workspaceRoot: string | null): Record<string, GitStatusCode> {
  const [statuses, setStatuses] = useState<Record<string, GitStatusCode>>({});

  useEffect(() => {
    if (!workspaceRoot) {
      setStatuses({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      const entry = await fetchStatus(workspaceRoot);
      if (!cancelled) setStatuses(entry.statuses);
    };
    void load();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string | null>).detail;
      // Refresh if the broadcast targets this root or all roots.
      if (detail === null || detail === workspaceRoot) {
        cache.delete(workspaceRoot);
        void load();
      }
    };
    window.addEventListener(REFRESH_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(REFRESH_EVENT, handler);
    };
  }, [workspaceRoot]);

  return statuses;
}
