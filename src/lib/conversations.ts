import type { ChatMessage } from '../components/AI/Message';

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
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
  try {
    const raw = (await window.suxai.conversations.read()) as unknown;
    if (Array.isArray(raw)) {
      // Legacy v1 — flat array of ChatMessage. Wrap it.
      const messages = raw as ChatMessage[];
      if (messages.length === 0) {
        return { version: 2, active: null, list: [] };
      }
      const conv: Conversation = {
        id: newId(),
        title: deriveTitle(messages),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages,
      };
      return { version: 2, active: conv.id, list: [conv] };
    }
    if (raw && typeof raw === 'object' && (raw as PersistedV2).version === 2) {
      const v2 = raw as PersistedV2;
      return {
        version: 2,
        active: v2.active ?? v2.list[0]?.id ?? null,
        list: Array.isArray(v2.list) ? v2.list : [],
      };
    }
  } catch (err) {
    console.warn('[conv] load failed:', err);
  }
  return { version: 2, active: null, list: [] };
}

export async function saveConversations(state: PersistedV2): Promise<void> {
  try {
    await window.suxai.conversations.write(state);
  } catch (err) {
    console.warn('[conv] save failed:', err);
  }
}
