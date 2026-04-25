import type { ChatMessage } from '../components/AI/Message';

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** When true, send tools with each request and run the agent loop. */
  agentMode?: boolean;
}

interface PersistedV2 {
  version: 2;
  active: string | null;
  list: Conversation[];
}

const TITLE_FALLBACK = 'New conversation';

function newId(): string {
  return crypto.randomUUID();
}

export function emptyConversation(): Conversation {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: TITLE_FALLBACK,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/**
 * Auto-generate a short title from the first user message — preserves
 * the previous "what is this conversation about" feel without us
 * having to round-trip the AI for a name.
 */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!firstUser) return TITLE_FALLBACK;
  const text = firstUser.content.replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text;
}

/**
 * Load conversations from disk (Electron userData JSON). Handles the
 * legacy v1 format (flat array of messages) by wrapping it as a single
 * conversation so users don't lose their history when upgrading.
 */
export async function loadConversations(): Promise<PersistedV2> {
  const empty: PersistedV2 = { version: 2, active: null, list: [] };
  try {
    const raw = (await window.suxai.conversations.read()) as unknown;
    if (raw == null) return empty;

    // Legacy v1 — flat array of ChatMessage. Wrap it in a single conv.
    if (Array.isArray(raw)) {
      const messages = (raw as ChatMessage[]).filter(
        (m) => m && typeof m.role === 'string' && typeof m.content === 'string',
      );
      if (messages.length === 0) return empty;
      const conv: Conversation = {
        id: newId(),
        title: deriveTitle(messages),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages,
      };
      return { version: 2, active: conv.id, list: [conv] };
    }

    // v2 payload — trust only the minimum shape; anything else falls back.
    if (typeof raw === 'object') {
      const obj = raw as Partial<PersistedV2>;
      if (obj.version === 2 && Array.isArray(obj.list)) {
        const list = obj.list.filter(
          (c): c is Conversation =>
            !!c && typeof c.id === 'string' && Array.isArray((c as Conversation).messages),
        );
        const active =
          (typeof obj.active === 'string' && list.some((c) => c.id === obj.active))
            ? obj.active
            : list[0]?.id ?? null;
        return sanitizeForPersist({ version: 2, active, list });
      }
    }
  } catch (err) {
    console.warn('[conv] load failed:', err);
  }
  return empty;
}

/**
 * Strip transient state before persisting. A `streaming` flag or a
 * `pending`/`running` tool call would replay back into the next session
 * as a stuck UI element (and chatToAgentMessages would skip them).
 */
function sanitizeForPersist(state: PersistedV2): PersistedV2 {
  return {
    ...state,
    list: state.list.map((c) => ({
      ...c,
      messages: c.messages.map((m) => {
        const next = { ...m, streaming: false };
        if (next.toolCalls && next.toolCalls.length > 0) {
          // Drop pending/running tool calls — they have no result, so
          // the next conversation render would show a forever-spinning
          // card and chatToAgentMessages would now ignore them anyway.
          const cleaned = next.toolCalls.filter(
            (tc) => tc.status !== 'pending' && tc.status !== 'running',
          );
          if (cleaned.length === 0) delete next.toolCalls;
          else next.toolCalls = cleaned;
        }
        return next;
      }),
    })),
  };
}

export async function saveConversations(state: PersistedV2): Promise<void> {
  try {
    await window.suxai.conversations.write(sanitizeForPersist(state));
  } catch (err) {
    console.warn('[conv] save failed:', err);
  }
}
