import { useEffect, useState } from 'react';

/**
 * v0.13.0 — Memory system, light version.
 *
 * Stores user-confirmed durable facts about the project / preferences
 * in localStorage, scoped per workspace root. Surfaced as a `<memories>`
 * block in the AI panel's preamble (rendered alongside AGENTS.md /
 * CLAUDE.md), so the model sees them on every turn.
 *
 * No server proxy, no Haiku rating loop in this MVP — that's slated
 * for v0.13.1+. For now: the user manually saves a memory via the
 * Settings dialog or a future toast; the model reads them; that's it.
 *
 * Storage key per workspace prevents cross-project leak: a "this
 * project uses Tailwind" memory from project A never leaks into
 * project B's prompt.
 */

export interface Memory {
  id: string;
  /** Short title (≤ 60 chars), surfaced as the bullet header. */
  title: string;
  /** Longer body (≤ 300 chars), one or two sentences. */
  content: string;
  /** Epoch ms — used for sort and pruning. Newest first when injected. */
  createdAt: number;
}

const KEY_PREFIX = 'suxai.memories.v1::';

function keyFor(workspaceRoot: string | null): string {
  return KEY_PREFIX + (workspaceRoot ?? 'global');
}

export function loadMemories(workspaceRoot: string | null): Memory[] {
  try {
    const raw = localStorage.getItem(keyFor(workspaceRoot));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is Memory =>
        m && typeof m.id === 'string' && typeof m.title === 'string' && typeof m.content === 'string',
    );
  } catch {
    return [];
  }
}

export function saveMemories(workspaceRoot: string | null, mems: Memory[]): void {
  try {
    // Cap at 20 most recent — keeps the prompt footprint bounded
    // (~20 × 360 chars ≈ 7 KB ≈ 1.7K tokens).
    const trimmed = [...mems]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);
    localStorage.setItem(keyFor(workspaceRoot), JSON.stringify(trimmed));
    window.dispatchEvent(
      new CustomEvent<{ workspaceRoot: string | null }>('suxai:memories-changed', {
        detail: { workspaceRoot },
      }),
    );
  } catch {
    /* ignore quota / serialisation errors — memories are best-effort */
  }
}

export function addMemory(
  workspaceRoot: string | null,
  m: Pick<Memory, 'title' | 'content'>,
): Memory {
  const memory: Memory = {
    id: crypto.randomUUID(),
    title: m.title.slice(0, 60).trim(),
    content: m.content.slice(0, 300).trim(),
    createdAt: Date.now(),
  };
  if (!memory.title || !memory.content) return memory;
  const all = loadMemories(workspaceRoot);
  saveMemories(workspaceRoot, [memory, ...all]);
  return memory;
}

export function deleteMemory(workspaceRoot: string | null, id: string): void {
  saveMemories(
    workspaceRoot,
    loadMemories(workspaceRoot).filter((m) => m.id !== id),
  );
}

/**
 * Render the memories as a markdown bullet list, ready to be wrapped
 * in `<memories>...</memories>` and prepended to the user's first
 * turn alongside AGENTS.md.
 *
 * Empty list → empty string (so `${formatMemories(...)}` is always
 * safe to interpolate without conditional logic at the call site).
 */
export function formatMemories(mems: Memory[]): string {
  if (mems.length === 0) return '';
  const lines = mems.map(
    (m) => `- **${m.title}** — ${m.content}`,
  );
  return `<memories>\nUser-confirmed durable facts about this project / preferences. Apply them silently when relevant.\n\n${lines.join('\n')}\n</memories>`;
}

/**
 * React hook that subscribes to memory changes for the current
 * workspace and returns the latest list. Re-renders on add/delete
 * across components (the hook fires on the `suxai:memories-changed`
 * window event emitted by `saveMemories`).
 */
export function useMemories(workspaceRoot: string | null): Memory[] {
  const [list, setList] = useState<Memory[]>(() => loadMemories(workspaceRoot));
  useEffect(() => {
    setList(loadMemories(workspaceRoot));
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ workspaceRoot: string | null }>).detail;
      if (detail?.workspaceRoot === workspaceRoot) {
        setList(loadMemories(workspaceRoot));
      }
    };
    window.addEventListener('suxai:memories-changed', handler);
    return () => window.removeEventListener('suxai:memories-changed', handler);
  }, [workspaceRoot]);
  return list;
}
