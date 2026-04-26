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

function isStatusCode(c: string): c is GitStatusCode {
  return c === 'M' || c === 'A' || c === 'D' || c === 'U' || c === 'R' || c === 'C';
}

async function fetchStatus(cwd: string): Promise<CacheEntry> {
  const existing = inflight.get(cwd);
  if (existing) return existing;
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
      for (const [path, code] of Object.entries(res.statuses)) {
        if (isStatusCode(code)) filtered[path] = code;
      }
      return { fetchedAt: Date.now(), statuses: filtered, root: res.root };
    } catch {
      return { fetchedAt: Date.now(), statuses: {}, root: null };
    }
  })();
  inflight.set(cwd, promise);
  try {
    const entry = await promise;
    cache.set(cwd, entry);
    return entry;
  } finally {
    inflight.delete(cwd);
  }
}

/** Force the next call to refetch — invoked after Save / diff accept. */
export function invalidateGitStatus(cwd?: string): void {
  if (cwd) cache.delete(cwd);
  else cache.clear();
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
