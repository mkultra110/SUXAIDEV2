import type { ToolCallSnapshot } from '../components/AI/Message';

export interface EditedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** Aggregate status across all hunks for this file:
   *   - 'pending'   → at least one tool call awaiting user decision
   *   - 'streaming' → currently being applied
   *   - 'accepted'  → all tool calls completed successfully
   *   - 'rejected'  → user rejected
   *   - 'error'     → at least one tool failed
   */
  status: 'pending' | 'streaming' | 'accepted' | 'rejected' | 'error';
  /** Number of distinct tool_use calls that touched this file. */
  hunkCount: number;
}

function lineCount(s: string | undefined): number {
  if (!s) return 0;
  if (s.length === 0) return 0;
  return s.split('\n').length;
}

/**
 * Aggregate per-file edit summaries from an assistant message's
 * `toolCalls`. Walks through edit_file / write_file calls, extracts
 * the path + computes a +N/-M delta from the search/replace inputs
 * (or from the file's content for write_file), and groups by path.
 *
 * Read-only tools (read_file, list_dir, run_command) are ignored.
 */
export function extractEditedFiles(
  toolCalls: ToolCallSnapshot[] | undefined,
): EditedFileSummary[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const byPath = new Map<string, EditedFileSummary>();

  for (const tc of toolCalls) {
    let path: string | undefined;
    let added = 0;
    let removed = 0;
    if (tc.name === 'edit_file' && tc.input && typeof tc.input === 'object') {
      const inp = tc.input as Record<string, unknown>;
      path = typeof inp.path === 'string' ? inp.path : undefined;
      added = lineCount(typeof inp.replace === 'string' ? inp.replace : '');
      removed = lineCount(typeof inp.search === 'string' ? inp.search : '');
    } else if (tc.name === 'write_file' && tc.input && typeof tc.input === 'object') {
      const inp = tc.input as Record<string, unknown>;
      path = typeof inp.path === 'string' ? inp.path : undefined;
      added = lineCount(typeof inp.content === 'string' ? inp.content : '');
      removed = 0;
    } else {
      continue;
    }
    if (!path) continue;

    const existing = byPath.get(path);
    if (existing) {
      existing.added += added;
      existing.removed += removed;
      existing.hunkCount += 1;
      existing.status = mergeStatus(existing.status, tc.status);
    } else {
      byPath.set(path, {
        path,
        added,
        removed,
        hunkCount: 1,
        status: snapshotToFileStatus(tc.status),
      });
    }
  }

  return [...byPath.values()];
}

function snapshotToFileStatus(s: ToolCallSnapshot['status']): EditedFileSummary['status'] {
  switch (s) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'streaming';
    case 'done':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'error':
      return 'error';
  }
}

function mergeStatus(
  a: EditedFileSummary['status'],
  b: ToolCallSnapshot['status'],
): EditedFileSummary['status'] {
  // Worst-of-both wins so the user sees a problematic file flag
  // even if other hunks succeeded. Order: error > rejected > pending
  // > streaming > accepted.
  const rank = { error: 5, rejected: 4, pending: 3, streaming: 2, accepted: 1 } as const;
  const bMapped = snapshotToFileStatus(b);
  return rank[a] >= rank[bMapped] ? a : bMapped;
}

/** Aggregate counts across a list of EditedFileSummary. */
export function totalStats(files: EditedFileSummary[]): {
  added: number;
  removed: number;
  pending: number;
  total: number;
} {
  let added = 0;
  let removed = 0;
  let pending = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
    if (f.status === 'pending' || f.status === 'streaming') pending += 1;
  }
  return { added, removed, pending, total: files.length };
}
