/**
 * v4.3.5 — Server health monitor.
 *
 * Polls /health every 60s in the background. Surfaces three states :
 *   - 'ok'         : 200 with disk/memory healthy
 *   - 'degraded'   : 200 with disk >95% used or <500MB free, OR 503
 *   - 'down'       : network failure, DNS, refused, timeout
 *
 * The StatusBar uses this to show a discreet pill ONLY when not 'ok'
 * — silent when everything's fine, visible when the user should know
 * (typically right before the disk-full incident on 2026-05-01 would
 * have flipped this to 'degraded' a long time before /auth/login
 * started timing out).
 *
 * Pure subscriber model : the hook polls when at least one component
 * mounted with `useServerHealth()`. No global polling otherwise —
 * cheap on idle.
 */
import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../config';

export type ServerHealthStatus = 'unknown' | 'ok' | 'degraded' | 'down';

export interface ServerHealth {
  status: ServerHealthStatus;
  /** Free disk MB on the VPS, when reported. */
  diskFreeMB?: number;
  /** Used disk pct on the VPS, when reported. */
  diskUsedPct?: number;
  /** Server uptime in seconds, when reported. */
  uptimeSec?: number;
  /** Server-reported version. Useful to detect a deploy mismatch. */
  serverVersion?: string;
  /** Human-readable warning the server attached (e.g. "Disk space critical"). */
  warning?: string;
  /** When this health snapshot was last refreshed. */
  fetchedAt: number;
}

const POLL_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

let lastSnapshot: ServerHealth = {
  status: 'unknown',
  fetchedAt: 0,
};
const subscribers = new Set<(s: ServerHealth) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchOnce(): Promise<ServerHealth> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE_URL}/health`, {
      method: 'GET',
      signal: ac.signal,
    });
    // 503 = degraded (per server contract since v4.3.0).
    const isDegraded = res.status === 503;
    if (!res.ok && !isDegraded) {
      return { status: 'down', fetchedAt: Date.now() };
    }
    const data = (await res.json().catch(() => null)) as
      | {
          version?: string;
          uptimeSec?: number;
          disk?: { freeMB?: number; usedPct?: number };
          warning?: string;
        }
      | null;
    return {
      status: isDegraded ? 'degraded' : 'ok',
      diskFreeMB: data?.disk?.freeMB,
      diskUsedPct: data?.disk?.usedPct,
      uptimeSec: data?.uptimeSec,
      serverVersion: data?.version,
      warning: data?.warning,
      fetchedAt: Date.now(),
    };
  } catch {
    return { status: 'down', fetchedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

async function poll(): Promise<void> {
  const snap = await fetchOnce();
  lastSnapshot = snap;
  subscribers.forEach((cb) => {
    try { cb(snap); } catch { /* */ }
  });
}

function ensurePolling(): void {
  if (pollTimer != null) return;
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer == null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

export function useServerHealth(): ServerHealth {
  const [snap, setSnap] = useState<ServerHealth>(lastSnapshot);

  useEffect(() => {
    subscribers.add(setSnap);
    ensurePolling();
    // Si on a un snapshot frais, sync immédiatement (évite un flash
    // 'unknown' au mount d'un nouveau composant).
    if (lastSnapshot.fetchedAt > 0) setSnap(lastSnapshot);
    return () => {
      subscribers.delete(setSnap);
      if (subscribers.size === 0) stopPolling();
    };
  }, []);

  return snap;
}
