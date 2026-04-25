import { z } from 'zod';

export const SUPPORTED_MODELS = [
  // Anthropic (Claude) — /v1/messages compatible
  { id: 'claude-sonnet-4-6-thinking', provider: 'anthropic', label: 'Claude Sonnet 4.6 (thinking)' },
  { id: 'claude-opus-4-6-thinking', provider: 'anthropic', label: 'Claude Opus 4.6 (thinking)' },
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', label: 'Claude Haiku 4.5' },

  // OpenAI-compatible — /v1/chat/completions
  { id: 'gemini-3.1-pro', provider: 'openai', label: 'Gemini 3.1 Pro' },
  { id: 'gemini-3-flash', provider: 'openai', label: 'Gemini 3 Flash' },
  { id: 'gpt-5.4', provider: 'openai', label: 'GPT-5.4' },
  { id: 'gpt-5.2', provider: 'openai', label: 'GPT-5.2' },
  { id: 'gpt-5.1-codex', provider: 'openai', label: 'GPT-5.1 Codex' },
  { id: 'gpt-5.1-codex-max', provider: 'openai', label: 'GPT-5.1 Codex Max' },
  { id: 'gpt-5.2-codex', provider: 'openai', label: 'GPT-5.2 Codex' },
  { id: 'gpt-5.3-codex', provider: 'openai', label: 'GPT-5.3 Codex' },
] as const;

export type AiProvider = 'anthropic' | 'openai';
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export function findModel(id: string): SupportedModel | undefined {
  return SUPPORTED_MODELS.find((m) => m.id === id);
}

// Agent-mode content blocks. When `agentMessages` / `tools` are present,
// the request takes precedence over `prompt` + `history` and we hand the
// Anthropic API the rich block-shaped messages directly.
//
// `cache_control` lives on every block — the server adds ephemeral
// breakpoints for prompt caching after validation, but we also accept
// pre-marked breakpoints from the client (e.g. for tools dumps) so the
// schema doesn't reject them.
const cacheControl = z
  .object({ type: z.literal('ephemeral') })
  .optional();
// Per-block byte caps. v0.11.1 raises this to 8 MB (Express body
// cap was bumped to 64 MB in tandem). Large generated files,
// transcripts of long agent loops, and gigantic tool_result dumps
// from grep on big monorepos all benefit. The schema is the real
// safety net — even at 8 MB, an agentMessages array with 200
// messages × 200 blocks each would still be far over the 64 MB
// body limit, so practical sends stay reasonable.
const MAX_BLOCK_TEXT = 8_000_000; // 8 MB per text/tool_result block
const textBlock = z.object({
  type: z.literal('text'),
  text: z.string().max(MAX_BLOCK_TEXT),
  cache_control: cacheControl,
});
const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().max(200),
  name: z.string().max(80),
  input: z.unknown(),
  cache_control: cacheControl,
});
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().max(200),
  content: z.string().max(MAX_BLOCK_TEXT),
  is_error: z.boolean().optional(),
  cache_control: cacheControl,
});
const contentBlock = z.union([textBlock, toolUseBlock, toolResultBlock]);

const toolDefinition = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(4000),
  input_schema: z.record(z.string(), z.unknown()),
  cache_control: cacheControl,
});

export const aiRequestSchema = z
  .object({
    modelId: z.string().refine((v) => SUPPORTED_MODELS.some((m) => m.id === v), {
      message: 'Unsupported model',
    }),
    command: z.enum(['explain', 'refactor', 'fix', 'optimize', 'edit', 'chat']).default('chat'),
    /** Operating mode for agent flows. 'composer' = full agent with
     *  edit/write/run; 'ask' = read-only Plan mode that produces
     *  a markdown plan via create_plan only. Defaults to 'composer'
     *  for back-compat when older clients don't send the field. */
    mode: z.enum(['composer', 'ask']).default('composer'),
    prompt: z.string().max(16_000_000, 'Prompt too large'),
    /** Optional override for the upstream max_tokens output cap.
     *  Defaults: 32K in agent mode, 16K in plain chat (v0.11.1).
     *  Capped at 64K (Anthropic's hard limit on Sonnet/Opus 4.x).
     *  Send a bigger value when the user explicitly asks the model
     *  to rewrite a large file in one turn. */
    max_output_tokens: z.number().int().min(1024).max(64000).optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1).max(4_000_000),
        }),
      )
      .max(100)
      .optional(),
    context: z
      .object({
        filePath: z.string().optional(),
        language: z.string().optional(),
        fileContent: z.string().max(16_000_000).optional(),
        selection: z.string().max(2_000_000).optional(),
      })
      .optional(),
    // --- Agent-mode extensions ---
    tools: z.array(toolDefinition).max(30).optional(),
    agentMessages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.union([z.string(), z.array(contentBlock).max(200)]),
        }),
      )
      .max(200)
      .optional(),
  })
  .refine(
    (v) => (v.agentMessages && v.agentMessages.length > 0) || v.prompt.trim().length > 0,
    { message: 'Prompt cannot be empty', path: ['prompt'] },
  );

export type AiRequestInput = z.infer<typeof aiRequestSchema>;

/**
 * Inline completion (Tab autocomplete) request schema. Powers
 * /ai/complete which forwards to a fast model (Haiku 4.5) with an
 * FIM-style prompt. Kept lean: 8 KB prefix / 8 KB suffix max so the
 * model latency stays under ~300 ms target.
 */
export const aiCompleteSchema = z.object({
  /** Code immediately before the caret (most recent at end). */
  prefix: z.string().max(8000),
  /** Code immediately after the caret. */
  suffix: z.string().max(8000),
  /** File language id (typescript, cpp, python, …). Helps the model
   *  pick the right syntax. */
  language: z.string().max(32).optional(),
  /** Optional bag of nearby snippets the client wants to bias the
   *  completion towards (recently edited code, related symbols, etc.). */
  related_context: z.string().max(16000).optional(),
  /** Cap on output tokens. Default 200; max 1024. */
  max_tokens: z.number().int().min(16).max(1024).optional(),
});

export type AiCompleteInput = z.infer<typeof aiCompleteSchema>;

/**
 * Apply-model request schema. Powers /ai/apply — a fast Haiku 4.5
 * call that merges a "lazy edit" (the kind that contains
 * `// ... existing code ...` markers) into the full original
 * content. Lets the planner model (Sonnet/Opus) emit short
 * edit blocks instead of rewriting the whole file, while still
 * producing the final complete file the diff view needs.
 */
export const aiApplySchema = z.object({
  /** Original file content (server treats it opaquely; sandboxed client
   *  side already capped to ATTACHMENT_HARD_CAP). 4 MB hard cap here. */
  original: z.string().max(4_000_000),
  /** The lazy edit emitted by the planner. Contains
   *  `// ... existing code ...` markers between the parts the model
   *  actually wants to change. */
  lazy_edit: z.string().max(2_000_000),
  /** Short user-facing instruction the planner used. Helps the apply
   *  model resolve ambiguity in the lazy edit. Optional. */
  instruction: z.string().max(2000).optional(),
  /** Path of the file being edited — used as a hint in the apply
   *  prompt (language detection, not a write target). Optional. */
  path: z.string().max(1024).optional(),
});

export type AiApplyInput = z.infer<typeof aiApplySchema>;
