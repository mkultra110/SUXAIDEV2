import { env } from '../config/env.js';
import { findModel, type AiRequestInput } from '../schemas/ai.js';

/**
 * v0.15.10 (audit-4 #1) — strip HTML/JS-flavoured chars from upstream
 * Quatarly error bodies before we put them in an Error message that
 * may eventually flow back to the client. An attacker proxying or
 * compromising upstream could otherwise reflect XSS-shaped strings or
 * leak internal headers in our error pipeline.
 */
function sanitizeUpstreamErr(text: string): string {
  return text
    .slice(0, 300)
    .replace(/[<>"'`]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * v0.15.10 (audit-4 #5, #10) — bound every non-streaming Quatarly
 * fetch with a hard timeout so a hung upstream can't tie up event-loop
 * slots indefinitely. 30 s is conservative for Haiku's apply / FIM /
 * count-tokens calls (typical p99 < 5 s). Streaming /v1/messages calls
 * have their own abort plumbing through the request signal, so they
 * route through plain fetch.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface StreamHandlers {
  onDelta: (chunk: string) => void;
  onToolUse?: (call: { id: string; name: string; input: unknown }) => void;
  /** v0.12: thinking block emitted once content_block_stop arrives.
   *  Carries the cryptographic `signature` Anthropic requires
   *  byte-for-byte on the next turn whenever the model later chains
   *  a tool_use; without round-tripping it the API returns 400
   *  "Expected thinking or redacted_thinking block". */
  onThinkingBlock?: (block: { thinking: string; signature: string }) => void;
  /** v0.12: opaque blob returned by Anthropic when it strips a
   *  thinking block. Must be returned verbatim on subsequent turns. */
  onRedactedThinking?: (block: { data: string }) => void;
  /** v0.12: server-side tool use (e.g. web_search). We don't dispatch
   *  these — Anthropic ran them on its end. We just round-trip them. */
  onServerToolUse?: (call: { id: string; name: string; input: unknown }) => void;
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
    'Never repeat the entire file unless asked. ' +
    // v0.12.9 — global blacklist: even in plain chat mode (no tools),
    // the model must never emit Cline/Roo/Cursor pseudo-XML edit
    // conventions. The IDE only renders inline diffs from real
    // `edit_file` tool calls; pseudo-XML in the chat is dead weight
    // the user has to copy/paste manually.
    'NEVER emit any of these in your replies: `<apply_diff>` blocks, ' +
    '`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` markers, ' +
    '`<edit>` / `<replace>` / `<diff>` / `<file_diff>` pseudo-XML, ' +
    '`*** Begin Patch` / `*** End Patch` (Cursor format), or ' +
    '`--- a/file` / `+++ b/file` standalone unified-diff hunks. ' +
    'Those are conventions from other IDEs (Cline, Roo, aider, Cursor) ' +
    'and SUXAI does not parse them. If you have edit tools (agent ' +
    'mode), call `edit_file`. If you do not, describe the change in ' +
    'prose with a regular fenced code block — never with pseudo-XML.';
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
      // v0.12.9 — explicit blacklist of Cline/Roo/Cursor inline-edit
      // pseudo-XML conventions. Sonnet/Opus thinking models trained
      // on a lot of those prompts and silently regress to dumping
      // `<apply_diff>` blocks in the chat instead of calling the
      // `edit_file` tool. The user sees the raw markup as text, has
      // to copy-paste manually, and the inline diff UX is bypassed.
      '  • FORBIDDEN OUTPUT FORMATS — never emit any of these in your ' +
      'reply, they are conventions from other IDEs (Cline / Roo / ' +
      'aider) and SUXAI does not parse them:\n' +
      '      `<apply_diff>` / `</apply_diff>` blocks\n' +
      '      `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` markers\n' +
      '      `<edit>` / `<replace>` / `<diff>` / `<file_diff>` pseudo-XML\n' +
      '      `*** Begin Patch` / `*** End Patch` (Cursor format)\n' +
      '      Standalone `--- a/file` / `+++ b/file` unified-diff hunks\n' +
      '    If you catch yourself writing any of these markers, STOP — ' +
      'you must emit a real `edit_file` tool call instead. The IDE ' +
      'will render the diff inline only via tool calls.\n' +
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

export async function streamCompletion(
  req: AiRequestInput,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
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
    await streamAnthropic(model.id, req, handlers, signal);
  } else {
    await streamOpenAI(model.id, req, handlers, signal);
  }
}

async function streamOpenAI(modelId: string, req: AiRequestInput, h: StreamHandlers, signal?: AbortSignal): Promise<void> {
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
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`upstream ${res.status}: ${sanitizeUpstreamErr(text)}`);
    }
    const reader = res.body.getReader();
    if (signal) {
      signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
    }
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

async function streamAnthropic(modelId: string, req: AiRequestInput, h: StreamHandlers, signal?: AbortSignal): Promise<void> {
  const url = `${env.QUATARLY_BASE_URL.replace(/\/$/, '')}/v1/messages`;

  // Build the messages payload. Two paths:
  //   1. Agent mode (req.agentMessages provided) — block-shaped messages
  //      forwarded as-is, with `tools` enabled. The model will emit
  //      tool_use blocks; the client runs them and posts results back
  //      in subsequent turns.
  //   2. Plain chat (existing behaviour) — flat string history collapsed
  //      to alternating user/assistant turns.
  const isAgent = Array.isArray(req.agentMessages) && req.agentMessages.length > 0;

  // v0.12.3 (audit #7): the schema accepts `cache_control` on every
  // block so client-supplied hints aren't rejected at parse time, but
  // the server is the single authority over cache breakpoints. We
  // strip any client-provided hint here before adding our own — that
  // way a buggy or malicious client can't push the request past the
  // 4-breakpoint Anthropic cap.
  function stripClientCacheControl(messages: unknown[]): unknown[] {
    return messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const msg = m as { role: string; content: unknown };
      if (typeof msg.content === 'string') return msg;
      if (!Array.isArray(msg.content)) return msg;
      const cleaned = (msg.content as Array<Record<string, unknown>>).map((b) => {
        if (!b || typeof b !== 'object' || !('cache_control' in b)) return b;
        const { cache_control: _drop, ...rest } = b;
        return rest;
      });
      return { ...msg, content: cleaned };
    });
  }

  // Attach an ephemeral cache breakpoint to the last content block of
  // the last message so Anthropic keeps the whole prefix
  // (system + tools + prior messages) hot. Writes cost 1.25× input once;
  // every subsequent turn reads the cache at 0.10× input.
  //
  // v0.12.3 (audit #8): when the last message contains ONLY
  // `tool_result` blocks (synthetic user response to a parallel tool
  // batch), skip the rolling breakpoint. Tagging a tool_result is a
  // cache write on volatile content that won't be hit on the next
  // turn anyway — the cache_control on system + tools already covers
  // the stable prefix. Saves the 1.25× write multiplier on every
  // multi-tool agent turn.
  //
  // v0.12.4 (audit #16): skip when the cumulative messages prefix is
  // below the Anthropic min-cacheable size (≈ 1024 tokens / 4096
  // chars for Sonnet/Opus). A breakpoint there is a silent no-op on
  // Anthropic's side but still costs the 1.25× write multiplier.
  // Heuristic: 4 chars/token. system + tools breakpoints handle the
  // small-prefix case fine.
  const MIN_CACHEABLE_CHARS = 4096;
  function approxCharCount(content: unknown): number {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return 0;
    let n = 0;
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') n += b.text.length;
      else if (b.type === 'tool_result' && typeof b.content === 'string') n += b.content.length;
      // tool_use / thinking / redacted_thinking contribute negligibly
      // to the prefix-cache decision; ignore for the heuristic.
    }
    return n;
  }

  function markRollingCache(
    messages: unknown[],
  ): unknown[] {
    if (messages.length === 0) return messages;
    // v0.12.4: cumulative size guard.
    let totalChars = 0;
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      totalChars += approxCharCount((m as { content?: unknown }).content);
      if (totalChars >= MIN_CACHEABLE_CHARS) break;
    }
    if (totalChars < MIN_CACHEABLE_CHARS) return messages;
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
      const blocks = last.content.slice() as Array<Record<string, unknown>>;
      // v0.12.3: skip tool_result-only synthetic user turns.
      const allToolResults = blocks.length > 0 && blocks.every(
        (b) => b && b.type === 'tool_result',
      );
      if (allToolResults) return messages;
      // Mutate a shallow copy of the blocks, tag only the last text-like
      // block with cache_control. We skip tool_use blocks because they
      // carry no `text` field.
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

  // v0.12: enable extended thinking for `*-thinking` model IDs.
  // Anthropic requires `thinking.budget_tokens < max_tokens`, so we
  // size the budget at half of max_tokens (capped at 16K, the spec's
  // recommended ceiling for tool-using agents). Quatarly may already
  // route `-thinking` IDs to a thinking-enabled deployment, but
  // including this parameter explicitly is harmless on a non-thinking
  // backend and required on the real Anthropic API.
  const isThinking = modelId.endsWith('-thinking');
  const thinkingParam = (max: number): { type: 'enabled'; budget_tokens: number } => ({
    type: 'enabled',
    budget_tokens: Math.min(16000, Math.max(1024, Math.floor(max / 2))),
  });

  let body: Record<string, unknown>;
  if (isAgent) {
    const max = requestedMax ?? 32000;
    body = {
      model: modelId,
      // v0.11.1: bumped 16K → 32K. The model was self-limiting at
      // ~300-line edits because it was anticipating a 16K cap; with
      // 32K it can confidently emit a full 2K-line refactor in one
      // turn (paired with apply_lazy_edit when even bigger).
      max_tokens: max,
      stream: true,
      system: cachedSystem(buildSystemPrompt(req.command, true, req.mode)),
      messages: markRollingCache(stripClientCacheControl(req.agentMessages ?? [])),
      tools: cachedTools(req.tools ?? []),
    };
    if (isThinking) body.thinking = thinkingParam(max);
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
    const max = requestedMax ?? 16000;
    body = {
      model: modelId,
      // Plain chat: bumped 8K → 16K so explanations + long code
      // examples + walkthroughs can stream in one shot.
      max_tokens: max,
      stream: true,
      system: cachedSystem(buildSystemPrompt(req.command)),
      messages: markRollingCache(cleaned),
    };
    if (isThinking) body.thinking = thinkingParam(max);
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
        // v0.12.3 (audit #6): when the model is a `*-thinking`
        // variant, also enable interleaved-thinking-2025-05-14 so
        // the model can emit thinking blocks BETWEEN parallel
        // tool_uses of the same turn. Without it, Anthropic returns
        // 400 the moment a thinking block appears mid-tool-chain.
        'anthropic-beta': isThinking
          ? 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11,interleaved-thinking-2025-05-14'
          : 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
        authorization: `Bearer ${env.QUATARLY_API_KEY}`,
        'x-api-key': env.QUATARLY_API_KEY,
        apiKey: env.QUATARLY_API_KEY,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`upstream ${res.status}: ${sanitizeUpstreamErr(text)}`);
    }
    const reader = res.body.getReader();
    // v0.11.7: forward the route's AbortSignal to the upstream
    // reader so a client disconnect tears the Quatarly call down
    // immediately. Without this the upstream kept generating until
    // its own stop_reason while nobody was reading.
    if (signal) {
      signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });
    }
    // fatal:false so a truncated multi-byte UTF-8 char at a chunk
    // boundary becomes U+FFFD instead of throwing — the next chunk's
    // continuation bytes will still complete the codepoint.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let buf = '';
    // Track in-progress content blocks. Anthropic streams a tool_use
    // as: content_block_start (with id+name+empty input) → many
    // input_json_delta events → content_block_stop. We accumulate the
    // partial JSON and emit a single onToolUse when it closes UNLESS
    // the stream was truncated by max_tokens — in that case the
    // partial is malformed and we drop it (retrying upstream is the
    // caller's job).
    //
    // v0.12: thinking blocks stream as content_block_start (type=
    // 'thinking', empty thinking) → many thinking_delta events → one
    // signature_delta event → content_block_stop. The signature is a
    // cryptographic envelope that MUST round-trip byte-for-byte on
    // subsequent turns or Anthropic returns 400. Same for
    // redacted_thinking (data is set on content_block_start) and
    // server_tool_use (same shape as tool_use).
    type PendingBlock =
      | { kind: 'text' }
      | { kind: 'tool_use'; id: string; name: string; partial: string }
      | { kind: 'thinking'; thinking: string; signature: string }
      | { kind: 'redacted_thinking'; data: string }
      | { kind: 'server_tool_use'; id: string; name: string; partial: string };
    const blocks: Map<number, PendingBlock> = new Map();
    let lastStopReason: string | null = null;
    let sawMessageStop = false;

    /**
     * Pull the next complete SSE frame out of `buf`. SSE separates
     * events with a blank line — RFC 8895 §9.2 specifies it as
     * `\n\n`, but proxies in the wild (Caddy, nginx) sometimes
     * inject CRLF. Handle both. Returns `null` when the buffer
     * doesn't yet contain a full frame.
     */
    const takeFrame = (): string | null => {
      const lf = buf.indexOf('\n\n');
      const crlf = buf.indexOf('\r\n\r\n');
      let end: number;
      let sepLen: number;
      if (lf < 0 && crlf < 0) return null;
      if (crlf < 0 || (lf >= 0 && lf < crlf)) {
        end = lf;
        sepLen = 2;
      } else {
        end = crlf;
        sepLen = 4;
      }
      const frame = buf.slice(0, end);
      buf = buf.slice(end + sepLen);
      return frame;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let frame: string | null;
      while ((frame = takeFrame()) !== null) {
        // A frame can contain multiple lines; join them as the SSE
        // spec dictates (concatenate all `data:` lines with '\n').
        // Anthropic in practice emits single-line `data:` payloads
        // but we honour the spec for robustness against proxies.
        let payload = '';
        for (const rawLine of frame.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          if (payload) payload += '\n';
          payload += line.slice(5).trimStart();
        }
        if (!payload) continue;
        let obj: Record<string, unknown> & { type?: string; delta?: Record<string, unknown>; index?: number; content_block?: Record<string, unknown>; error?: Record<string, unknown> };
        try {
          obj = JSON.parse(payload);
        } catch {
          // Malformed JSON in a data: payload should NEVER happen
          // from Anthropic. Log silently and keep going — continuing
          // is safer than tearing the whole stream down.
          continue;
        }

        if (obj.type === 'content_block_start') {
          const i = obj.index ?? 0;
          const cb = obj.content_block as Record<string, unknown> | undefined;
          const cbType = cb?.type as string | undefined;
          if (cbType === 'tool_use') {
            blocks.set(i, {
              kind: 'tool_use',
              id: cb!.id as string,
              name: cb!.name as string,
              partial: '',
            });
          } else if (cbType === 'server_tool_use') {
            blocks.set(i, {
              kind: 'server_tool_use',
              id: cb!.id as string,
              name: cb!.name as string,
              partial: '',
            });
          } else if (cbType === 'thinking') {
            // Anthropic occasionally sends the entire thinking text on
            // start (rare) — seed the pending block with whatever's
            // already there and append deltas in content_block_delta.
            blocks.set(i, {
              kind: 'thinking',
              thinking: typeof cb!.thinking === 'string' ? (cb!.thinking as string) : '',
              signature: typeof cb!.signature === 'string' ? (cb!.signature as string) : '',
            });
          } else if (cbType === 'redacted_thinking') {
            // Redacted blocks come whole — `data` is set on start and
            // not modified by deltas. We still wait for content_block_stop
            // before emitting so we don't race ahead of the stream.
            blocks.set(i, {
              kind: 'redacted_thinking',
              data: typeof cb!.data === 'string' ? (cb!.data as string) : '',
            });
          } else {
            blocks.set(i, { kind: 'text' });
          }
        } else if (obj.type === 'content_block_delta') {
          const i = obj.index ?? 0;
          const block = blocks.get(i);
          const delta = obj.delta as {
            type?: string;
            text?: string;
            partial_json?: string;
            thinking?: string;
            signature?: string;
          } | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            if (delta.text.length > 0) h.onDelta(delta.text);
          } else if (
            delta?.type === 'input_json_delta' &&
            (block?.kind === 'tool_use' || block?.kind === 'server_tool_use') &&
            typeof delta.partial_json === 'string'
          ) {
            block.partial += delta.partial_json;
          } else if (
            delta?.type === 'thinking_delta' &&
            block?.kind === 'thinking' &&
            typeof delta.thinking === 'string'
          ) {
            block.thinking += delta.thinking;
          } else if (
            delta?.type === 'signature_delta' &&
            block?.kind === 'thinking' &&
            typeof delta.signature === 'string'
          ) {
            // Signature is a single-shot field — Anthropic emits one
            // signature_delta per thinking block. We accept either
            // exactly-once or accumulated form for safety.
            block.signature = delta.signature;
          }
          // citations_delta is still dropped — it's metadata-only and
          // doesn't affect the round-trip invariant.
        } else if (obj.type === 'content_block_stop') {
          const i = obj.index ?? 0;
          const block = blocks.get(i);
          if (block?.kind === 'tool_use' || block?.kind === 'server_tool_use') {
            // Don't try to emit a tool_use when the stream was
            // truncated mid-input-json by max_tokens — the partial
            // is guaranteed-malformed and dispatching it would
            // execute a tool with garbage args.
            if (lastStopReason === 'max_tokens') {
              // Skip emission. The route already received the
              // stop_reason event and will report max_tokens to the
              // caller; the caller retries with max_tokens × 2.
            } else {
              let input: unknown = {};
              let inputOk = true;
              try {
                input = block.partial ? JSON.parse(block.partial) : {};
              } catch {
                inputOk = false;
              }
              if (inputOk) {
                if (block.kind === 'tool_use') {
                  h.onToolUse?.({ id: block.id, name: block.name, input });
                } else {
                  h.onServerToolUse?.({ id: block.id, name: block.name, input });
                }
              } else {
                // Parsed-failure with NO max_tokens marker: rare,
                // typically a network corruption. Don't dispatch a
                // garbage tool — surface as an error to the caller.
                throw new Error(
                  `${block.kind} input_json was malformed JSON (block.id=${block.id}, ` +
                    `${block.partial.length} chars accumulated)`,
                );
              }
            }
          } else if (block?.kind === 'thinking') {
            // Round-trip the thinking block to the client even if
            // signature is missing — better to send what we have than
            // drop it; Anthropic only enforces signature on the
            // next-turn request, not on the current response.
            h.onThinkingBlock?.({
              thinking: block.thinking,
              signature: block.signature,
            });
          } else if (block?.kind === 'redacted_thinking') {
            h.onRedactedThinking?.({ data: block.data });
          }
          blocks.delete(i);
        } else if (obj.type === 'message_delta') {
          const delta = obj.delta as { stop_reason?: string } | undefined;
          if (typeof delta?.stop_reason === 'string') {
            // v0.15.7 (audit-2 #5) — log unknown stop_reason values so
            // upstream typos / new Anthropic codes show up in /opt/suxai/
            // logs/server.log instead of silently flowing to clients
            // that have to fall through to the catch-all break path.
            const VALID_STOP_REASONS = new Set([
              'end_turn',
              'tool_use',
              'max_tokens',
              'pause_turn',
              'refusal',
              'stop_sequence',
              'model_context_window_exceeded',
            ]);
            if (!VALID_STOP_REASONS.has(delta.stop_reason)) {
              console.warn('[quatarly] unexpected stop_reason:', delta.stop_reason);
            }
            lastStopReason = delta.stop_reason;
            h.onStop?.(delta.stop_reason);
          }
        } else if (obj.type === 'message_stop') {
          sawMessageStop = true;
          h.onDone();
          return;
        } else if (obj.type === 'ping') {
          // SSE keepalive — ignore. Useful only as a liveness signal.
        } else if (obj.type === 'error') {
          const errBody = obj.error as { type?: string; message?: string } | undefined;
          throw new Error(
            `${errBody?.type ?? 'anthropic_error'}: ${errBody?.message ?? 'unknown'}`,
          );
        }
      }
    }
    if (!sawMessageStop) {
      // Stream EOF without a message_stop event = truncation
      // (network drop, upstream proxy idle timeout, Anthropic 529).
      // anthropic-sdk-typescript #842 documents this exact failure
      // mode. Throw a structured error so the caller doesn't treat
      // a partial response as end_turn.
      const err = new Error(
        'Stream ended without message_stop event (upstream truncated)',
      );
      (err as Error & { code?: string }).code = 'STREAM_TRUNCATED';
      throw err;
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
    // v0.15.10 (audit-4 #5) — 30s upper bound on Haiku FIM call.
    const res = await fetchWithTimeout(url, {
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
    // v0.15.10 (audit-4 #5) — bounded 30s on apply-model calls.
    const res = await fetchWithTimeout(url, {
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
    const merged = piece.text.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');
    // v0.12.4 (audit #22): truncation guard. Haiku's 64K output cap
    // can silently cut a 5K-line file mid-statement; without this
    // check the user accepts a corrupted save. Compare line counts —
    // refuse the merge if we lost more than 60 % of the original
    // lines, signalling caller to fall back on the raw lazy edit.
    // Marker leakage detection: if the literal `// ... existing code
    // ...` survived into the output, the apply model failed at its
    // job and we'd be saving placeholder comments verbatim.
    const origLines = input.original.split('\n').length;
    const mergedLines = merged.split('\n').length;
    if (origLines > 50 && mergedLines < origLines * 0.4) {
      return null; // suspected truncation
    }
    if (/\/\/\s*\.\.\.\s*existing code\s*\.\.\.|#\s*\.\.\.\s*existing code\s*\.\.\./i.test(merged)) {
      return null; // marker leaked — apply model failed
    }
    return merged;
  } catch {
    return null;
  }
}

/**
 * v0.12.6: count tokens for an Anthropic-shaped request without
 * actually generating. Powers the client's compaction trigger so we
 * stop relying on the 4 chars/token heuristic. Returns
 * `{ input_tokens: number }` on success, `null` if the upstream
 * doesn't support count_tokens (Quatarly may forward it or 404).
 *
 * Caller is responsible for caching — this hits the network every
 * call. Server-side caching is risky because the agentMessages
 * payload changes shape every turn anyway.
 */
export async function countTokens(
  input: import('../schemas/ai.js').AiCountTokensInput,
): Promise<{ input_tokens: number } | null> {
  const model = findModel(input.modelId);
  if (!model || model.provider !== 'anthropic') return null;
  if (!env.QUATARLY_API_KEY) return null;
  const url = `${env.QUATARLY_BASE_URL.replace(/\/$/, '')}/v1/messages/count_tokens`;
  const isThinking = input.modelId.endsWith('-thinking');
  const body: Record<string, unknown> = {
    model: input.modelId,
    messages: input.agentMessages,
    system: buildSystemPrompt('chat', true, 'composer'),
  };
  if (input.tools && input.tools.length > 0) body.tools = input.tools;
  if (isThinking) {
    // Anthropic requires the same `thinking` shape as the actual
    // request — mirroring 32K/2 = 16K matches our agent-mode default.
    body.thinking = { type: 'enabled', budget_tokens: 16000 };
  }
  try {
    // v0.15.10 (audit-4 #10) — bounded 15s on count-tokens (cheap call).
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': isThinking
          ? 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11,interleaved-thinking-2025-05-14'
          : 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11',
        authorization: `Bearer ${env.QUATARLY_API_KEY}`,
        'x-api-key': env.QUATARLY_API_KEY,
        apiKey: env.QUATARLY_API_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const obj = (await res.json()) as { input_tokens?: number };
    if (typeof obj.input_tokens !== 'number') return null;
    return { input_tokens: obj.input_tokens };
  } catch {
    return null;
  }
}

