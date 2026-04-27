import { API_BASE_URL } from '../config';
import { tryRefreshToken } from './client';

export type AiCommand = 'explain' | 'refactor' | 'fix' | 'optimize' | 'edit' | 'chat';

export interface AiHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentTextBlock { type: 'text'; text: string }
export interface AgentToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface AgentToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/**
 * Extended-thinking block (Sonnet/Opus 4.x with thinking).
 * `signature` is a cryptographic envelope Anthropic computes — it
 * MUST be round-tripped byte-for-byte on subsequent turns or the
 * model rejects the request with 400.
 */
export interface AgentThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}
/**
 * Redacted thinking — Anthropic strips a thinking block it can't
 * disclose but still requires the opaque `data` blob to be returned
 * verbatim so the cryptographic chain stays intact.
 */
export interface AgentRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}
/**
 * Server-side tool use (e.g. web_search) executed by Anthropic
 * directly. We don't dispatch these — we just round-trip them so
 * the model's container/state is preserved across turns.
 */
export interface AgentServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: unknown;
}
export type AgentContentBlock =
  | AgentTextBlock
  | AgentToolUseBlock
  | AgentToolResultBlock
  | AgentThinkingBlock
  | AgentRedactedThinkingBlock
  | AgentServerToolUseBlock;
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | AgentContentBlock[];
}

export interface AiRequest {
  modelId: string;
  command: AiCommand;
  prompt: string;
  /** Prior turns of the conversation, oldest-first. Used to keep the
   *  model coherent across follow-ups ("fix it", "now in TypeScript"…). */
  history?: AiHistoryTurn[];
  context?: {
    filePath?: string;
    language?: string;
    fileContent?: string;
    selection?: string;
  };
  // Agent-mode extensions. Set both to enable tool-using agent loop.
  tools?: { name: string; description: string; input_schema: unknown }[];
  agentMessages?: AgentMessage[];
  /** Operating mode: 'composer' = full agent (default), 'ask' = Plan
   *  mode (read-only + create_plan). Server uses this to pick the
   *  right system-prompt suffix. */
  mode?: 'composer' | 'ask';
}

export interface AiStreamHandlers {
  onToken?: (chunk: string) => void;
  onToolUse?: (call: { id: string; name: string; input: unknown }) => void;
  /** v0.12: extended-thinking block emitted at the end of its
   *  content_block_stop. The signature must round-trip on the next
   *  request — store it on the assistant message as an
   *  AgentThinkingBlock so chatToAgentMessages includes it. */
  onThinkingBlock?: (block: AgentThinkingBlock) => void;
  /** v0.12: opaque redacted_thinking blob — same round-trip rule. */
  onRedactedThinking?: (block: AgentRedactedThinkingBlock) => void;
  /** v0.12: server-side tool use (e.g. web_search) — Anthropic ran it,
   *  we just preserve the block on the next turn. */
  onServerToolUse?: (call: AgentServerToolUseBlock) => void;
  onStop?: (reason: string) => void;
  onDone?: (full: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Streams an AI completion from the VPS proxy (/ai/chat).
 * The VPS holds the Quatarly API key and forwards the request.
 * Returns an abort function.
 */
export function streamAi(
  token: string,
  req: AiRequest,
  handlers: AiStreamHandlers,
): () => void {
  const controller = new AbortController();
  const url = `${API_BASE_URL}/ai/chat`;

  const doFetch = (authToken: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

  (async () => {
    let full = '';
    try {
      let res = await doFetch(token);

      // Auto-refresh on expired token — the SSE path bypasses the normal
      // api/client wrapper, so we replicate its 401-retry behaviour here.
      if (res.status === 401) {
        // Drain the failed response body so the underlying socket is
        // returned to the pool cleanly before we open a fresh request.
        try { await res.text(); } catch { /* already consumed / aborted */ }
        const fresh = await tryRefreshToken();
        if (fresh) res = await doFetch(fresh);
      }

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`AI request failed (${res.status}): ${text.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Parse lines: `data: {"delta": "..."}\n\n` and `data: [DONE]\n\n`
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            handlers.onDone?.(full);
            return;
          }
          interface SseEvent {
            delta?: string;
            tool_use?: { id: string; name: string; input: unknown };
            /** v0.12: thinking block — the cryptographic `signature`
             *  must be round-tripped verbatim on the next request. */
            thinking_block?: { thinking: string; signature: string };
            redacted_thinking?: { data: string };
            server_tool_use?: { id: string; name: string; input: unknown };
            stop_reason?: string;
            error?: string;
            /** v0.11.7: server tags errors with a typed code so the
             *  client can decide whether the partial response is
             *  worth retrying (STREAM_TRUNCATED → yes, ratelimit →
             *  yes with backoff, anthropic_error → no). */
            code?: string;
          }
          let obj: SseEvent | null = null;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (obj?.error) {
            const e = new Error(obj.error) as Error & { code?: string };
            if (obj.code) e.code = obj.code;
            throw e;
          }
          if (obj?.delta) {
            full += obj.delta;
            handlers.onToken?.(obj.delta);
          }
          if (obj?.tool_use) {
            handlers.onToolUse?.(obj.tool_use);
          }
          if (obj?.thinking_block) {
            handlers.onThinkingBlock?.({
              type: 'thinking',
              thinking: obj.thinking_block.thinking,
              signature: obj.thinking_block.signature,
            });
          }
          if (obj?.redacted_thinking) {
            handlers.onRedactedThinking?.({
              type: 'redacted_thinking',
              data: obj.redacted_thinking.data,
            });
          }
          if (obj?.server_tool_use) {
            handlers.onServerToolUse?.({
              type: 'server_tool_use',
              id: obj.server_tool_use.id,
              name: obj.server_tool_use.name,
              input: obj.server_tool_use.input,
            });
          }
          if (obj?.stop_reason) {
            handlers.onStop?.(obj.stop_reason);
          }
        }
      }
      handlers.onDone?.(full);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      handlers.onError?.(err as Error);
    }
  })().catch((err: unknown) => {
    if ((err as Error)?.name !== 'AbortError') {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return () => controller.abort();
}

export function buildCommandPrompt(command: AiCommand, userText: string): string {
  switch (command) {
    case 'explain':
      return `Explain the selected code clearly and concisely. Highlight non-obvious behavior.\n\n${userText}`;
    case 'refactor':
      return `Refactor the selected code for readability and maintainability without changing behavior. Return the final code in a single fenced block, then a short changelog.\n\n${userText}`;
    case 'fix':
      return `Identify bugs in the selected code and propose a fix. Return corrected code in a fenced block, then explain the fix.\n\n${userText}`;
    case 'optimize':
      return `Optimize the selected code for performance and memory. Preserve the public API and behavior. Return the final code in a single fenced block, then a short list of the optimizations applied.\n\n${userText}`;
    case 'edit':
      return `Apply the following instruction to the selected code. Return ONLY the modified code in a single fenced code block — no commentary, no explanation, no prose before or after the code block. Keep everything outside the instruction unchanged.\n\n${userText}`;
    case 'chat':
    default:
      return userText;
  }
}

/**
 * v0.12.8: count input tokens for a prospective Anthropic request.
 * Hits the VPS /ai/count-tokens proxy which forwards to
 * `/v1/messages/count_tokens`. Returns `null` on any failure (network,
 * upstream not supporting the endpoint, malformed response) so the
 * caller can fall back to its own heuristic without surfacing errors.
 *
 * Don't call on every keystroke — Anthropic bills count_tokens as
 * input. The compaction trigger debounces at 30 s + only fires above
 * an 80 % heuristic threshold, so the budget stays minimal.
 */
export async function countTokens(
  token: string,
  modelId: string,
  agentMessages: AgentMessage[],
  tools?: { name: string; description: string; input_schema: unknown }[],
): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/ai/count-tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ modelId, agentMessages, tools }),
    });
    if (!res.ok) return null;
    const obj = (await res.json()) as { input_tokens?: number | null };
    return typeof obj.input_tokens === 'number' ? obj.input_tokens : null;
  } catch {
    return null;
  }
}
