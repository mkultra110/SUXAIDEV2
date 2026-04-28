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

/** v0.16.0 — raw porcelain XY codes (X = index/staged, Y = worktree). */
export interface GitDetail {
  x: string;
  y: string;
}

interface CacheEntry {
  fetchedAt: number;
  /** Absolute path → status code. Empty when the workspace isn't a repo. */
  statuses: Record<string, GitStatusCode>;
  /** v0.16.0 — per-path raw XY for staged/unstaged bucketing. */
  detail: Record<string, GitDetail>;
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
      return { fetchedAt: Date.now(), statuses: {}, detail: {}, root: null };
    }
    try {
      const res = await window.suxai.git.status({ cwd });
      if (!res.ok) {
        return { fetchedAt: Date.now(), statuses: {}, detail: {}, root: null };
      }
      const filtered: Record<string, GitStatusCode> = {};
      for (const [p, code] of Object.entries(res.statuses)) {
        if (isStatusCode(code)) filtered[normalizeGitPath(p)] = code;
      }
      const filteredDetail: Record<string, GitDetail> = {};
      for (const [p, d] of Object.entries(res.detail ?? {})) {
        if (d && typeof d === 'object' && typeof d.x === 'string' && typeof d.y === 'string') {
          filteredDetail[normalizeGitPath(p)] = { x: d.x, y: d.y };
        }
      }
      return {
        fetchedAt: Date.now(),
        statuses: filtered,
        detail: filteredDetail,
        root: res.root,
      };
    } catch {
      return { fetchedAt: Date.now(), statuses: {}, detail: {}, root: null };
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

/** v0.16.0 — richer hook for the Source Control panel : returns
 *  the same statuses map PLUS the per-path XY detail and the repo
 *  root so we can bucket Staged / Unstaged / Untracked / Conflicts
 *  without re-querying. Same cache + refresh-event plumbing. */
export interface GitFullStatus {
  statuses: Record<string, GitStatusCode>;
  detail: Record<string, GitDetail>;
  root: string | null;
}
export function useGitFullStatus(workspaceRoot: string | null): GitFullStatus {
  const [state, setState] = useState<GitFullStatus>({
    statuses: {},
    detail: {},
    root: null,
  });

  useEffect(() => {
    if (!workspaceRoot) {
      setState({ statuses: {}, detail: {}, root: null });
      return;
    }
    let cancelled = false;
    const load = async () => {
      const entry = await fetchStatus(workspaceRoot);
      if (!cancelled) {
        setState({
          statuses: entry.statuses,
          detail: entry.detail,
          root: entry.root,
        });
      }
    };
    void load();
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string | null>).detail;
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

  return state;
}

/** v0.16.0 — stage paths and refresh badges. Returns the IPC error
 *  message if anything failed (toast it client-side). */
export async function stagePaths(cwd: string, paths: string[]): Promise<string | null> {
  if (!window.suxai?.git?.stage) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.stage({ cwd, paths });
    invalidateGitStatus(cwd);
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message ?? 'stage failed';
  }
}

/** v0.16.0 — unstage paths (git restore --staged + reset HEAD fallback). */
export async function unstagePaths(cwd: string, paths: string[]): Promise<string | null> {
  if (!window.suxai?.git?.unstage) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.unstage({ cwd, paths });
    invalidateGitStatus(cwd);
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message ?? 'unstage failed';
  }
}

/** v0.16.0 — commit. Returns short SHA on success, error message on failure. */
export async function commitStaged(cwd: string, message: string): Promise<{ ok: true; sha: string | null; branch: string | null } | { ok: false; error: string }> {
  if (!window.suxai?.git?.commit) return { ok: false, error: 'git IPC unavailable' };
  try {
    const res = await window.suxai.git.commit({ cwd, message });
    invalidateGitStatus(cwd);
    return res;
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'commit failed' };
  }
}

/* ====================================================================
 * v0.16.16 — Branch + network ops.
 * ==================================================================== */

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  upstream?: string;
  lastCommitRel?: string;
  isRemote: boolean;
}

export interface GitBranchState {
  branch: string | null;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

const BRANCH_REFRESH_EVENT = 'suxai:git-branch-refresh';

export function broadcastBranchRefresh(): void {
  window.dispatchEvent(new CustomEvent(BRANCH_REFRESH_EVENT));
}

/** React hook : returns current branch + ahead/behind counts.
 *  Refreshes on mount, on every git-status invalidate broadcast,
 *  and on the dedicated branch-refresh broadcast (fired after
 *  push/pull/fetch/checkout). */
export function useGitBranchState(workspaceRoot: string | null): GitBranchState {
  const [state, setState] = useState<GitBranchState>({
    branch: null, ahead: 0, behind: 0, hasUpstream: false,
  });
  useEffect(() => {
    if (!workspaceRoot) {
      setState({ branch: null, ahead: 0, behind: 0, hasUpstream: false });
      return;
    }
    let cancelled = false;
    const load = async () => {
      if (!window.suxai?.git) return;
      try {
        const [bRes, abRes] = await Promise.all([
          window.suxai.git.currentBranch({ cwd: workspaceRoot }),
          window.suxai.git.aheadBehind({ cwd: workspaceRoot }),
        ]);
        if (cancelled) return;
        setState({
          branch: bRes.ok ? bRes.branch : null,
          ahead: abRes.ok ? abRes.ahead : 0,
          behind: abRes.ok ? abRes.behind : 0,
          hasUpstream: abRes.ok ? abRes.hasUpstream : false,
        });
      } catch {
        if (!cancelled) {
          setState({ branch: null, ahead: 0, behind: 0, hasUpstream: false });
        }
      }
    };
    void load();
    const handler = () => { void load(); };
    window.addEventListener(BRANCH_REFRESH_EVENT, handler);
    window.addEventListener('suxai:git-refresh', handler);
    return () => {
      cancelled = true;
      window.removeEventListener(BRANCH_REFRESH_EVENT, handler);
      window.removeEventListener('suxai:git-refresh', handler);
    };
  }, [workspaceRoot]);
  return state;
}

export async function gitFetch(cwd: string): Promise<string | null> {
  if (!window.suxai?.git?.fetch) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.fetch({ cwd });
    invalidateGitStatus(cwd);
    broadcastBranchRefresh();
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function gitPull(cwd: string): Promise<string | null> {
  if (!window.suxai?.git?.pull) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.pull({ cwd });
    invalidateGitStatus(cwd);
    broadcastBranchRefresh();
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function gitPush(cwd: string, force = false): Promise<string | null> {
  if (!window.suxai?.git?.push) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.push({ cwd, force });
    invalidateGitStatus(cwd);
    broadcastBranchRefresh();
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function listBranches(cwd: string): Promise<GitBranchInfo[]> {
  if (!window.suxai?.git?.branches) return [];
  try {
    const res = await window.suxai.git.branches({ cwd });
    return res.ok ? res.branches : [];
  } catch {
    return [];
  }
}

export async function checkoutBranch(
  cwd: string,
  branch: string,
  create = false,
): Promise<string | null> {
  if (!window.suxai?.git?.checkout) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.checkout({ cwd, branch, create });
    invalidateGitStatus(cwd);
    broadcastBranchRefresh();
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

/* ====================================================================
 * v2.3 (Lot C) — Blame + log + stash.
 * ==================================================================== */

export interface BlameLine {
  sha: string;
  author: string;
  dateIso: string;
  summary: string;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  subject: string;
  body: string;
}

export interface GitStash {
  ref: string;
  index: number;
  sha: string;
  subject: string;
  dateIso: string;
}

// Blame cache. Keyed by `${cwd}::${file}`. Cleared on every
// 'suxai:git-refresh' broadcast — that fires after save/commit/
// checkout/pull/etc., so blame stays in sync without manual eviction.
const blameCache = new Map<string, BlameLine[]>();
const blameInflight = new Map<string, Promise<BlameLine[]>>();

if (typeof window !== 'undefined') {
  window.addEventListener('suxai:git-refresh', () => {
    blameCache.clear();
  });
}

/** Read `git blame --line-porcelain HEAD <file>` cached per-file.
 *  Returns `[]` for untracked / new files (not an error). */
export async function getFileBlame(cwd: string, file: string): Promise<BlameLine[]> {
  if (!window.suxai?.git?.blame) return [];
  const key = `${cwd}::${file}`;
  const cached = blameCache.get(key);
  if (cached) return cached;
  const inflight = blameInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const res = await window.suxai.git.blame({ cwd, file });
      if (!res.ok) return [];
      return res.lines;
    } catch {
      return [];
    }
  })();
  blameInflight.set(key, promise);
  try {
    const lines = await promise;
    blameCache.set(key, lines);
    return lines;
  } finally {
    blameInflight.delete(key);
  }
}

/** One-shot `git log -n<limit>`. No cache — the log viewer modal
 *  refetches on open so it always reflects current HEAD. */
export async function getGitLog(cwd: string, limit = 100): Promise<GitCommit[]> {
  if (!window.suxai?.git?.log) return [];
  try {
    const res = await window.suxai.git.log({ cwd, limit });
    return res.ok ? res.commits : [];
  } catch {
    return [];
  }
}

export async function listStashes(cwd: string): Promise<GitStash[]> {
  if (!window.suxai?.git?.stashList) return [];
  try {
    const res = await window.suxai.git.stashList({ cwd });
    return res.ok ? res.stashes : [];
  } catch {
    return [];
  }
}

/** React hook : reactive stash list. Refreshes on every
 *  `suxai:git-refresh` broadcast (which fires after stash push/pop/
 *  drop/apply/commit). */
export function useGitStashes(workspaceRoot: string | null): GitStash[] {
  const [stashes, setStashes] = useState<GitStash[]>([]);
  useEffect(() => {
    if (!workspaceRoot) {
      setStashes([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const list = await listStashes(workspaceRoot);
      if (!cancelled) setStashes(list);
    };
    void load();
    const handler = () => { void load(); };
    window.addEventListener('suxai:git-refresh', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('suxai:git-refresh', handler);
    };
  }, [workspaceRoot]);
  return stashes;
}

export async function stashPush(
  cwd: string,
  message?: string,
  includeUntracked = false,
): Promise<string | null> {
  if (!window.suxai?.git?.stashPush) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.stashPush({ cwd, message, includeUntracked });
    invalidateGitStatus(cwd);
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function stashPop(cwd: string, index: number): Promise<string | null> {
  if (!window.suxai?.git?.stashPop) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.stashPop({ cwd, index });
    invalidateGitStatus(cwd);
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function stashApply(cwd: string, index: number): Promise<string | null> {
  if (!window.suxai?.git?.stashApply) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.stashApply({ cwd, index });
    invalidateGitStatus(cwd);
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function stashDrop(cwd: string, index: number): Promise<string | null> {
  if (!window.suxai?.git?.stashDrop) return 'git IPC unavailable';
  try {
    const res = await window.suxai.git.stashDrop({ cwd, index });
    invalidateGitStatus(cwd);
    return res.ok ? null : res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Format `dateIso` as a short relative string ("3 days ago",
 *  "2 hours ago", etc.). Used by blame widget + log viewer. */
export function relativeTime(dateIso: string): string {
  if (!dateIso) return '';
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
