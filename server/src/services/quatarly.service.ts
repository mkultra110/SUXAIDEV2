import { env } from '../config/env.js';
import { findModel, type AiRequestInput } from '../schemas/ai.js';

export interface StreamHandlers {
  onDelta: (chunk: string) => void;
  onToolUse?: (call: { id: string; name: string; input: unknown }) => void;
  onStop?: (reason: 'end_turn' | 'tool_use' | 'max_tokens' | string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

function buildSystemPrompt(command: AiRequestInput['command'], agent = false): string {
  const base =
    'You are SUXAI, a senior AI software engineer embedded in an IDE. ' +
    'Be precise and concise. When returning code, use fenced code blocks. ' +
    'Never repeat the entire file unless asked.';
  if (agent) {
    return (
      base +
      '\n\nYou are operating in AGENT mode. You have tools to read and edit ' +
      "the user's files (read_file, list_dir, edit_file, write_file). Use them " +
      'to understand the project before making changes. Always read a file ' +
      'before editing it. Prefer minimal, surgical edits via edit_file. ' +
      'When you finish, briefly summarize what you changed and why. ' +
      'If a request is ambiguous, ask before acting.'
    );
  }
  switch (command) {
    case 'explain':
      return `${base} Your task: explain the provided code clearly.`;
    case 'refactor':
      return `${base} Your task: refactor for readability and maintainability, keeping behavior identical. Return the complete refactored snippet in one code block followed by a short changelog.`;
    case 'fix':
      return `${base} Your task: find bugs and propose a fix. Return corrected code in one block, then a brief explanation.`;
    case 'optimize':
      return `${base} Your task: optimize for performance and memory while keeping the public API and behavior unchanged. Return the full optimized snippet in one fenced block, then a short list of the applied optimizations.`;
    case 'edit':
      return `${base} Your task: apply a precise edit to the code. The user will describe what to change. Return ONLY the modified code in a single fenced block. No commentary, no explanation, no surrounding prose. Preserve everything outside the scope of the instruction.`;
    default:
      return base;
  }
}

function buildUserContent(req: AiRequestInput): string {
  const parts: string[] = [];
  if (req.context?.filePath) {
    parts.push(`Active file: ${req.context.filePath}${req.context.language ? ` (${req.context.language})` : ''}`);
  }
  if (req.context?.selection) {
    parts.push(`Selected code:\n\`\`\`${req.context.language ?? ''}\n${req.context.selection}\n\`\`\``);
  } else if (req.context?.fileContent) {
    parts.push(`File content:\n\`\`\`${req.context.language ?? ''}\n${req.context.fileContent}\n\`\`\``);
  }
  parts.push(`Request: ${req.prompt}`);
  return parts.join('\n\n');
}

export async function streamCompletion(req: AiRequestInput, handlers: StreamHandlers): Promise<void> {
  const model = findModel(req.modelId);
  if (!model) {
    handlers.onError(new Error('Unsupported model'));
    return;
  }
  if (!env.QUATARLY_API_KEY) {
    handlers.onError(new Error('Server missing QUATARLY_API_KEY'));
    return;
  }

  if (model.provider === 'anthropic') {
    await streamAnthropic(model.id, req, handlers);
  } else {
    await streamOpenAI(model.id, req, handlers);
  }
}

async function streamOpenAI(modelId: string, req: AiRequestInput, h: StreamHandlers): Promise<void> {
  const url = `${env.QUATARLY_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`;
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildSystemPrompt(req.command) },
  ];
  if (req.history && req.history.length > 0) {
    for (const turn of req.history) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: 'user', content: buildUserContent(req) });
  const body = {
    model: modelId,
    stream: true,
    messages,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Quatarly accepts any of these; send all three so we match whichever
        // header its upstream validator checks.
        authorization: `Bearer ${env.QUATARLY_API_KEY}`,
        'x-api-key': env.QUATARLY_API_KEY,
        apiKey: env.QUATARLY_API_KEY,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          h.onDone();
          return;
        }
        try {
          const obj = JSON.parse(payload);
          const delta = obj.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) h.onDelta(delta);
        } catch {
          /* ignore */
        }
      }
    }
    h.onDone();
  } catch (err) {
    h.onError(err as Error);
  }
}

async function streamAnthropic(modelId: string, req: AiRequestInput, h: StreamHandlers): Promise<void> {
  const url = `${env.QUATARLY_BASE_URL.replace(/\/$/, '')}/v1/messages`;

  // Build the messages payload. Two paths:
  //   1. Agent mode (req.agentMessages provided) — block-shaped messages
  //      forwarded as-is, with `tools` enabled. The model will emit
  //      tool_use blocks; the client runs them and posts results back
  //      in subsequent turns.
  //   2. Plain chat (existing behaviour) — flat string history collapsed
  //      to alternating user/assistant turns.
  const isAgent = Array.isArray(req.agentMessages) && req.agentMessages.length > 0;

  let body: Record<string, unknown>;
  if (isAgent) {
    body = {
      model: modelId,
      max_tokens: 4096,
      stream: true,
      system: buildSystemPrompt(req.command, true),
      messages: req.agentMessages,
      tools: req.tools ?? [],
    };
  } else {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (req.history && req.history.length > 0) {
      for (const turn of req.history) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    messages.push({ role: 'user', content: buildUserContent(req) });
    const cleaned: typeof messages = [];
    for (const m of messages) {
      const last = cleaned[cleaned.length - 1];
      if (cleaned.length === 0 && m.role !== 'user') continue;
      if (last && last.role === m.role) {
        last.content = `${last.content}\n\n${m.content}`;
      } else {
        cleaned.push({ ...m });
      }
    }
    body = {
      model: modelId,
      max_tokens: 2048,
      stream: true,
      system: buildSystemPrompt(req.command),
      messages: cleaned,
    };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${env.QUATARLY_API_KEY}`,
        'x-api-key': env.QUATARLY_API_KEY,
        apiKey: env.QUATARLY_API_KEY,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Track in-progress content blocks. Anthropic streams a tool_use
    // as: content_block_start (with id+name+empty input) → many
    // input_json_delta events → content_block_stop. We accumulate the
    // partial JSON and emit a single onToolUse when it closes.
    type PendingBlock =
      | { kind: 'text' }
      | { kind: 'tool_use'; id: string; name: string; partial: string };
    const blocks: Map<number, PendingBlock> = new Map();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let obj: any;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }

        if (obj.type === 'content_block_start') {
          const i = obj.index;
          const cb = obj.content_block;
          if (cb?.type === 'tool_use') {
            blocks.set(i, {
              kind: 'tool_use',
              id: cb.id,
              name: cb.name,
              partial: '',
            });
          } else {
            blocks.set(i, { kind: 'text' });
          }
        } else if (obj.type === 'content_block_delta') {
          const i = obj.index;
          const block = blocks.get(i);
          if (obj.delta?.type === 'text_delta' && typeof obj.delta.text === 'string') {
            if (obj.delta.text.length > 0) h.onDelta(obj.delta.text);
          } else if (
            obj.delta?.type === 'input_json_delta' &&
            block?.kind === 'tool_use' &&
            typeof obj.delta.partial_json === 'string'
          ) {
            block.partial += obj.delta.partial_json;
          }
        } else if (obj.type === 'content_block_stop') {
          const i = obj.index;
          const block = blocks.get(i);
          if (block?.kind === 'tool_use') {
            let input: unknown = {};
            try {
              input = block.partial ? JSON.parse(block.partial) : {};
            } catch {
              input = { _raw: block.partial };
            }
            h.onToolUse?.({ id: block.id, name: block.name, input });
          }
          blocks.delete(i);
        } else if (obj.type === 'message_delta') {
          const reason = obj.delta?.stop_reason;
          if (typeof reason === 'string') h.onStop?.(reason);
        } else if (obj.type === 'message_stop') {
          h.onDone();
          return;
        } else if (obj.type === 'error') {
          throw new Error(obj.error?.message ?? 'Anthropic stream error');
        }
      }
    }
    h.onDone();
  } catch (err) {
    h.onError(err as Error);
  }
}
