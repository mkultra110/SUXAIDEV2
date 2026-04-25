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
const textBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: cacheControl,
});
const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  cache_control: cacheControl,
});
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.string(),
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
    prompt: z.string().max(2_000_000, 'Prompt too large'),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1).max(200_000),
        }),
      )
      .max(40)
      .optional(),
    context: z
      .object({
        filePath: z.string().optional(),
        language: z.string().optional(),
        fileContent: z.string().max(1_000_000).optional(),
        selection: z.string().max(200_000).optional(),
      })
      .optional(),
    // --- Agent-mode extensions ---
    tools: z.array(toolDefinition).max(20).optional(),
    agentMessages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.union([z.string(), z.array(contentBlock).max(80)]),
        }),
      )
      .max(120)
      .optional(),
  })
  .refine(
    (v) => (v.agentMessages && v.agentMessages.length > 0) || v.prompt.trim().length > 0,
    { message: 'Prompt cannot be empty', path: ['prompt'] },
  );

export type AiRequestInput = z.infer<typeof aiRequestSchema>;
