/**
 * v0.16.7 — File local history (recovery feature).
 *
 * Every successful save snapshots the file's content to userData/
 * History/<sha-256(path):16chars>/<epoch-ms>.txt. The user can browse
 * past snapshots via right-click → "Show local history" on a tab,
 * and open any snapshot as a read-only buffer to copy from.
 *
 * Caps enforced server-side :
 *   - 50 snapshots per file (oldest dropped on overflow)
 *   - skip if identical to last
 *   - skip if < 5 s since last (no spam during rapid Ctrl+S)
 *   - skip if content > 4 MB
 */

export interface HistorySnapshot {
  id: string;
  ts: number;
  sizeBytes: number;
}

/** Fire-and-forget snapshot. Returns silently on failure — history
 *  is best-effort and must never break the save flow. */
export async function snapshotFile(path: string, content: string): Promise<void> {
  if (!window.suxai?.history?.snapshot) return;
  try {
    await window.suxai.history.snapshot({ path, content });
  } catch {
    /* swallowed — history isn't critical */
  }
}

/** List all snapshots for a file, most-recent first. */
export async function listHistory(
  path: string,
): Promise<{ sha8: string; snapshots: HistorySnapshot[] }> {
  if (!window.suxai?.history?.list) {
    return { sha8: '', snapshots: [] };
  }
  try {
    const res = await window.suxai.history.list({ path });
    if (res.ok) return { sha8: res.sha8, snapshots: res.snapshots };
    return { sha8: '', snapshots: [] };
  } catch {
    return { sha8: '', snapshots: [] };
  }
}

/** Read one snapshot's content. Empty string on failure. */
export async function readSnapshot(sha8: string, id: string): Promise<string> {
  if (!window.suxai?.history?.read) return '';
  try {
    const res = await window.suxai.history.read({ sha8, id });
    if (res.ok) return res.content;
    return '';
  } catch {
    return '';
  }
}

/** Format a snapshot timestamp for display. Returns "today HH:mm",
 *  "yesterday HH:mm", or "MMM d, HH:mm" depending on age. */
export function formatSnapshotTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday = d.toDateString() === yesterday.toDateString();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  if (sameDay) return `today ${hh}:${mm}`;
  if (wasYesterday) return `yesterday ${hh}:${mm}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ` ${hh}:${mm}`;
}
