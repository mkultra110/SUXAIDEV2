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
// Per-block byte caps. The Express body cap is 32 MB (see
// server/src/index.ts); this per-field cap stays under a third of
// that so a single huge block can't be the whole payload. 4 MB
// covers very large files (entire codebases of small projects) in
// one block while still leaving headroom for the rest of the
// agentMessages array.
const MAX_BLOCK_TEXT = 4_000_000; // 4 MB per text/tool_result block
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
    prompt: z.string().max(8_000_000, 'Prompt too large'),
    /** Optional override for the upstream max_tokens output cap.
     *  Defaults: 16K in agent mode, 8K in plain chat. Capped at
     *  64K (Anthropic's hard limit on Sonnet/Opus 4.x). Send a
     *  bigger value when the user explicitly asks the model to
     *  rewrite a large file in one turn. */
    max_output_tokens: z.number().int().min(1024).max(64000).optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1).max(2_000_000),
        }),
      )
      .max(60)
      .optional(),
    context: z
      .object({
        filePath: z.string().optional(),
        language: z.string().optional(),
        fileContent: z.string().max(8_000_000).optional(),
        selection: z.string().max(1_000_000).optional(),
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
