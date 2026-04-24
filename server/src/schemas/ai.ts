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

export const aiRequestSchema = z.object({
  modelId: z.string().refine((v) => SUPPORTED_MODELS.some((m) => m.id === v), {
    message: 'Unsupported model',
  }),
  command: z.enum(['explain', 'refactor', 'fix', 'optimize', 'chat']).default('chat'),
  prompt: z.string().min(1, 'Prompt cannot be empty').max(60_000, 'Prompt too large'),
  context: z
    .object({
      filePath: z.string().optional(),
      language: z.string().optional(),
      fileContent: z.string().max(200_000).optional(),
      selection: z.string().max(50_000).optional(),
    })
    .optional(),
});

export type AiRequestInput = z.infer<typeof aiRequestSchema>;
