import { env } from '../config/env.js';
import { findModel, type AiRequestInput } from '../schemas/ai.js';

export interface StreamHandlers {
  onDelta: (chunk: string) => void;
  onToolUse?: (call: { id: string; name: string; input: unknown }) => void;
  onStop?: (reason: 'end_turn' | 'tool_use' | 'max_tokens' | string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

function buildSystemPrompt(
  command: AiRequestInput['command'],
  agent = false,
  mode: 'composer' | 'ask' = 'composer',
): string {
  const base =
    'You are SUXAI, a senior AI software engineer embedded in an IDE. ' +
    'Be precise and concise. When returning code, use fenced code blocks. ' +
    'Never repeat the entire file unless asked.';
  if (agent) {
    return (
      base +
      '\n\nYou are operating in AGENT mode. You have tools to read and edit ' +
      "the user's files (read_file, list_dir, edit_file, write_file, run_command). " +
      'Use them to understand the project before making changes. Always read a ' +
      'file before editing it.\n\n' +
      'CRITICAL — how to apply changes:\n' +
      '  • To MODIFY an existing file, ALWAYS use the `edit_file` tool with a ' +
      'small, surgical search/replace that touches only the lines you need to ' +
      'change. Do NOT rewrite the whole file.\n' +
      '  • To CREATE a new file, use `write_file`.\n' +
      '  • NEVER paste the modified file (or large code blocks of it) back into ' +
      'the chat as your "answer" — the user will not see it as a diff and you ' +
      'will burn tokens for nothing. Tool calls trigger an inline diff in the ' +
      "user's editor where they accept or reject each hunk individually; that " +
      'is the ONLY correct way to deliver edits in agent mode.\n' +
      '  • If the user just asks a question (no edit intent), answer in chat ' +
      'as normal — short code snippets for explanation are fine.\n\n' +
      // Pronoun resolution — the SUXAI client injects an
      // <additional_data> XML block before every user_query that
      // tells you which file is focused, what the user has selected,
      // recent edits, etc. Resolve demonstratives against this block
      // INSTEAD of asking the user to repeat themselves.
      'PRONOUN RESOLUTION (very important):\n' +
      '  Each user message includes an <additional_data> block before ' +
      'the actual <user_query>. Use it to resolve references silently:\n' +
      '    • "ce script" / "ce fichier" / "this file" / "the file" → ' +
      '<current_file path="…"> from <additional_data>\n' +
      '    • "cette fonction" / "this function" / "la fonction ci-dessus" → ' +
      'the smallest enclosing function around <current_file>.cursor_line ' +
      '(use read_file with a tight line range around that line)\n' +
      '    • "la sélection" / "this selection" / "ce code" → the contents ' +
      'of <selection> in <additional_data>\n' +
      '    • "le fichier que je viens d\'éditer" / "le précédent" → first ' +
      'entry of <recent_edits>\n' +
      '  ALWAYS confirm the resolved target in your first sentence: e.g. ' +
      '«Modification de `chams.cpp` (le fichier actif) lignes 142–155…». ' +
      'Never ask "quel fichier ?" if <current_file> is set — that is the ' +
      "answer.\n\n" +
      'When you finish, briefly summarize what you changed and why. ' +
      'If a request is ambiguous (e.g. genuinely no current_file and no ' +
      'selection), ask before acting.' +
      // Plan-mode override: when the user toggled Plan / Ask mode, the
      // model gets read-only tools + create_plan only. Reinforce this
      // in the prompt so the model doesn't try edit_file just because
      // it remembers the description from earlier turns.
      (mode === 'ask'
        ? '\n\nYou are currently in PLAN MODE (Cursor "Ask"). You ' +
          'have READ-ONLY tools (read_file, list_dir) plus the ' +
          'create_plan tool. You MUST NOT call edit_file, write_file ' +
          'or run_command — those are not exposed to you in this ' +
          'mode. Investigate the codebase, then produce ONE structured ' +
          'markdown plan via create_plan with this skeleton:\n' +
          '  ## Context — what the user asked, scope, assumptions\n' +
          '  ## Per-file analysis — markdown table | File | Issue | Fix |\n' +
          '  ## Already OK — checklist of files that need no change\n' +
          '  ## Implementation Plan — numbered, each step ≤ 1 file\n' +
          '  ## Walkthrough — wrap in <details><summary>Walkthrough</summary>…</details>\n' +
          '  ## Acceptance Criteria — checkboxes the user can tick after exec\n' +
          'Slug should be kebab-case derived from the user request ' +
          '(e.g. "fix-streamproof-bug"). After saving, tell the user ' +
          'how to flip Plan mode off to execute.'
        : '')
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

  // Attach an ephemeral cache breakpoint to the last content block of
  // the last message so Anthropic keeps the whole prefix
  // (system + tools + prior messages) hot. Writes cost 1.25× input once;
  // every subsequent turn reads the cache at 0.10× input.
  //
  // We only touch the LAST message's LAST block. Earlier cache_control
  // hints inside agentMessages passed by the client are left alone.
  function markRollingCache(
    messages: unknown[],
  ): unknown[] {
    if (messages.length === 0) return messages;
    const last = messages[messages.length - 1] as {
      role: string;
      content: unknown;
    };
    if (!last || typeof last !== 'object') return messages;
    let nextContent: unknown;
    if (typeof last.content === 'string') {
      nextContent = [
        {
          type: 'text',
          text: last.content,
          cache_control: { type: 'ephemeral' },
        },
      ];
    } else if (Array.isArray(last.content)) {
      // Mutate a shallow copy of the blocks, tag only the last text-like
      // block with cache_control. We skip tool_use blocks because they
      // carry no `text` field.
      const blocks = last.content.slice() as Array<Record<string, unknown>>;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b && (b.type === 'text' || b.type === 'tool_result')) {
          blocks[i] = { ...b, cache_control: { type: 'ephemeral' } };
          break;
        }
      }
      nextContent = blocks;
    } else {
      return messages;
    }
    return [
      ...messages.slice(0, -1),
      { ...last, content: nextContent },
    ];
  }

  // System prompt with a single cache breakpoint on the system text.
  // This covers the invariant instructions across every turn.
  function cachedSystem(text: string): Array<Record<string, unknown>> {
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  // Tools: mark the LAST tool's definition as a cache boundary so the
  // whole tool list is part of the cached prefix.
  function cachedTools<T extends Record<string, unknown>>(tools: T[]): T[] {
    if (tools.length === 0) return tools;
    const last = tools[tools.length - 1];
    return [
      ...tools.slice(0, -1),
      { ...last, cache_control: { type: 'ephemeral' } } as T,
    ];
  }

  let body: Record<string, unknown>;
  if (isAgent) {
    body = {
      model: modelId,
      max_tokens: 4096,
      stream: true,
      system: cachedSystem(buildSystemPrompt(req.command, true, req.mode)),
      messages: markRollingCache(req.agentMessages ?? []),
      tools: cachedTools(req.tools ?? []),
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
      system: cachedSystem(buildSystemPrompt(req.command)),
      messages: markRollingCache(cleaned),
    };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        // Enable prompt caching + the 1-hour TTL variant. Quatarly
        // forwards headers it doesn't know about, so if the provider
        // doesn't support them the request still succeeds (just no
        // cache hit). We're graceful.
        'anthropic-beta': 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
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
