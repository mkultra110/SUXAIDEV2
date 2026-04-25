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
      '  • To MODIFY an existing file, use `edit_file` with an exact ' +
      'search/replace pair. The `search` string must match a unique ' +
      'region of the file. For multi-region refactors, issue several ' +
      '`edit_file` calls (one per region) — they execute in parallel ' +
      'and the user sees them all in the inline diff.\n' +
      '  • To CREATE a new file (or fully replace one), use `write_file`.\n' +
      '  • DO NOT artificially fragment a large refactor into 4× more ' +
      'tool calls than necessary "to be safe". You have a 32K-token ' +
      'output budget and parallel tool calls are batched. Pick the ' +
      'right region size for each `edit_file` (usually 5-50 lines per ' +
      'call) and emit them all in one assistant turn.\n' +
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

  // Output capacity. Tuned for the typical agent workload (single
  // edit_file or write_file in one turn, sometimes with thinking).
  // Anthropic Sonnet/Opus 4.x officially go up to 64K output tokens
  // when streaming; 16K is a comfortable default that lets the
  // model rewrite a ~2000-line file in one tool call without hitting
  // stop_reason='max_tokens' mid-edit. Plain chat stays smaller —
  // explanations rarely need more than 8K. Override via per-request
  // body field `max_output_tokens` if the caller needs more.
  const requestedMax =
    typeof (req as Record<string, unknown>).max_output_tokens === 'number'
      ? Math.max(1024, Math.min(64000, Number((req as Record<string, unknown>).max_output_tokens)))
      : null;

  let body: Record<string, unknown>;
  if (isAgent) {
    body = {
      model: modelId,
      // v0.11.1: bumped 16K → 32K. The model was self-limiting at
      // ~300-line edits because it was anticipating a 16K cap; with
      // 32K it can confidently emit a full 2K-line refactor in one
      // turn (paired with apply_lazy_edit when even bigger).
      max_tokens: requestedMax ?? 32000,
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
      // Plain chat: bumped 8K → 16K so explanations + long code
      // examples + walkthroughs can stream in one shot.
      max_tokens: requestedMax ?? 16000,
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

/**
 * Non-streaming, fast-model completion used by Tab autocomplete.
 * Calls Haiku 4.5 with a FIM-style prompt and returns just the
 * inserted code. No system prompt cache breakpoints because the
 * call is single-shot — caching would cost more than it saves.
 *
 * Returns `null` on any error so callers can no-op silently —
 * autocomplete failure must NEVER surface to the user as a popup
 * (it would interrupt their typing).
 */
export async function completeFIM(input: import('../schemas/ai.js').AiCompleteInput): Promise<string | null> {
  if (!env.QUATARLY_API_KEY) return null;
  const url = `${env.QUATARLY_BASE_URL.replace(/\/$/, '')}/v1/messages`;
  const language = input.language ?? 'plaintext';
  // FIM prompt. Anthropic doesn't have a dedicated FIM mode, so we
  // emulate it with a single user message. The system prompt is
  // intentionally terse — Haiku is fast and follows tight
  // instructions well.
  const userText =
    (input.related_context
      ? `<related_context>\n${input.related_context}\n</related_context>\n\n`
      : '') +
    `<code_before lang="${language}">\n${input.prefix}</code_before>\n` +
    `<code_after>\n${input.suffix}</code_after>\n` +
    `Continue the code that goes between <code_before> and <code_after>. ` +
    `Output ONLY the inserted code, no explanation, no fences. Stop at a ` +
    `natural completion boundary (end of statement, end of expression).`;
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: input.max_tokens ?? 200,
    stream: false,
    system: [
      {
        type: 'text',
        text:
          'You are an inline code completion model. Output ONLY the code ' +
          'that fills in between the <code_before> and <code_after> tags. ' +
          'No prose, no fences, no <code_before>/<code_after> tags in your ' +
          'output. Match the language and indentation style of the prefix.',
      },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    ],
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${env.QUATARLY_API_KEY}`,
        'x-api-key': env.QUATARLY_API_KEY,
        apiKey: env.QUATARLY_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const obj = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    if (!obj.content || obj.content.length === 0) return null;
    const piece = obj.content.find((b) => b.type === 'text');
    if (!piece || typeof piece.text !== 'string') return null;
    // Strip stray code fences in case the model ignored the
    // instruction — happens occasionally even with Haiku.
    return piece.text.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');
  } catch {
    return null;
  }
}

/**
 * Apply-model fast-path. The planner (Sonnet/Opus) emits a "lazy
 * edit" with `// ... existing code ...` markers around the parts it
 * actually wants to change ; this helper asks Haiku 4.5 to merge
 * the lazy edit into the original file, producing the complete
 * rewritten file the diff view needs.
 *
 * Tokens saved: instead of having the expensive planner regenerate
 * a 2000-line file, it only has to emit the changed snippets +
 * markers. Haiku is ~10× cheaper per output token, so even when
 * Haiku does end up regenerating most of the file, the bill is
 * dramatically lower.
 *
 * Returns `null` on any error (network, 5xx, malformed response).
 * Caller then falls back to using the lazy_edit verbatim (the diff
 * view shows it as-is and the user can manually rework).
 */
export async function applyLazyEdit(input: import('../schemas/ai.js').AiApplyInput): Promise<string | null> {
  if (!env.QUATARLY_API_KEY) return null;
  const url = `${env.QUATARLY_BASE_URL.replace(/\/$/, '')}/v1/messages`;
  const langHint = input.path ? ` (file: ${input.path})` : '';

  const userText =
    `You will merge a lazy edit into the original file${langHint}.\n` +
    `The lazy edit contains marker comments like \`// ... existing code ...\` ` +
    `(or the language-appropriate variant: \`# ... existing code ...\` for ` +
    `Python, \`/* ... existing code ... */\` for CSS/JS, etc.) — those ` +
    `markers stand in for unchanged regions of the original file. Replace ` +
    `each marker with the corresponding original lines verbatim. The non-` +
    `marker portions of the lazy edit are the new code that should land in ` +
    `the file.\n\n` +
    (input.instruction ? `User instruction: ${input.instruction}\n\n` : '') +
    `<original_file>\n${input.original}\n</original_file>\n\n` +
    `<lazy_edit>\n${input.lazy_edit}\n</lazy_edit>\n\n` +
    `Output the COMPLETE final file content, no fences, no explanation, ` +
    `nothing else. Preserve every line of the original that wasn't touched ` +
    `by the lazy edit. Preserve the original file's indentation style and ` +
    `line endings.`;

  const body = {
    model: 'claude-haiku-4-5-20251001',
    // 64K — Anthropic's hard ceiling for Haiku's output. Lets the
    // apply model rewrite a ~5000-line file end-to-end in one go,
    // because Haiku's per-token cost is tiny relative to Sonnet/
    // Opus regenerating the same content.
    max_tokens: 64000,
    stream: false,
    system: [
      {
        type: 'text',
        text:
          'You are an apply model. Your sole job is to merge a "lazy edit" ' +
          'into an original file and output the resulting complete file. ' +
          'You preserve every unchanged line verbatim. You never explain. ' +
          'You never wrap output in code fences. You output ONLY the merged ' +
          'file content.',
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: userText }] },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${env.QUATARLY_API_KEY}`,
        'x-api-key': env.QUATARLY_API_KEY,
        apiKey: env.QUATARLY_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const obj = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    if (!obj.content || obj.content.length === 0) return null;
    const piece = obj.content.find((b) => b.type === 'text');
    if (!piece || typeof piece.text !== 'string') return null;
    return piece.text.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');
  } catch {
    return null;
  }
}
