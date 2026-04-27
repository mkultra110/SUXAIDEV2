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
 * v0.13.4 — extract durable facts from a finished conversation via
 * Haiku 4.5. Returns at most 5 candidates as an array of
 * `{ title, content }`. Caller is responsible for showing a UI
 * toast per candidate so the user can save / dismiss.
 *
 * Heuristic-gated to avoid burning tokens on trivial chats:
 *   • runs only when the conversation has ≥ 6 messages (3 user
 *     turns minimum)
 *   • runs at most ONCE per conversation id (caller tracks)
 *   • silently returns [] on any error — never surfaces to user
 *
 * The prompt is intentionally narrow: only project conventions,
 * style/lib preferences, recurring tools. Bug-of-the-day, current
 * task state, and ephemeral details are explicitly rejected.
 */
const MEMORY_EXTRACTION_PROMPT =
  'You are observing a conversation between a developer and an AI assistant. ' +
  'Extract DURABLE FACTS about the user\'s preferences or project conventions ' +
  '(NOT temporary session state).\n\n' +
  'Response format: valid JSON array of `{ "title": string ≤ 60 chars, "content": string ≤ 200 chars }`. ' +
  'If nothing is extractable: `[]`. Maximum 5 items.\n\n' +
  '**EXTRACT:** style/lib preferences (e.g. "Tailwind v4", "Result<T,E>"), ' +
  'project conventions (e.g. "tests in Vitest", "absolute imports"), ' +
  'user tooling (e.g. "uses pnpm not npm").\n\n' +
  '**DO NOT EXTRACT:** current task state, specific bug, ' +
  'exact file path, ad-hoc numeric value, "We are at step 3".\n\n' +
  'Respond ONLY with the JSON, no markdown, no explanation.';

export interface MemoryCandidate {
  title: string;
  content: string;
}

export async function extractMemoriesFromTranscript(
  transcript: string,
  fetchFn: (prompt: string) => Promise<string>,
): Promise<MemoryCandidate[]> {
  if (transcript.length < 200) return [];
  let raw: string;
  try {
    raw = await fetchFn(
      MEMORY_EXTRACTION_PROMPT + '\n\n<conversation>\n' + transcript + '\n</conversation>',
    );
  } catch {
    return [];
  }
  // Strip Haiku fences if any sneaked in.
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: MemoryCandidate[] = [];
  for (const item of parsed.slice(0, 5)) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).title === 'string' &&
      typeof (item as Record<string, unknown>).content === 'string'
    ) {
      const t = ((item as Record<string, unknown>).title as string).trim();
      const c = ((item as Record<string, unknown>).content as string).trim();
      if (t && c && t.length <= 80 && c.length <= 280) {
        out.push({ title: t.slice(0, 60), content: c.slice(0, 200) });
      }
    }
  }
  return out;
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
