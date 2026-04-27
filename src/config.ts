export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() || 'https://suxai.209-99-186-238.sslip.io';

export const UPDATE_MANIFEST_URL =
  import.meta.env.VITE_UPDATE_MANIFEST_URL?.trim() ||
  'https://suxai.209-99-186-238.sslip.io/update/manifest';

export type AiProvider = 'anthropic' | 'openai';

export interface AiModel {
  id: string;
  label: string;
  provider: AiProvider;
  tag?: string;
}

/**
 * Supported Quatarly models. The server owns the actual routing and API key.
 */
export const AI_MODELS: AiModel[] = [
  { id: 'claude-sonnet-4-6-thinking', label: 'Claude Sonnet 4.6 (thinking)', provider: 'anthropic', tag: 'balanced' },
  { id: 'claude-opus-4-6-thinking',   label: 'Claude Opus 4.6 (thinking)',   provider: 'anthropic', tag: 'smart' },
  { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',             provider: 'anthropic', tag: 'fast' },
  { id: 'gemini-3.1-pro',             label: 'Gemini 3.1 Pro',               provider: 'openai',    tag: 'balanced' },
  { id: 'gemini-3-flash',             label: 'Gemini 3 Flash',               provider: 'openai',    tag: 'fast' },
  { id: 'gpt-5.4',                    label: 'GPT-5.4',                      provider: 'openai',    tag: 'balanced' },
  { id: 'gpt-5.2',                    label: 'GPT-5.2',                      provider: 'openai',    tag: 'balanced' },
  { id: 'gpt-5.1-codex',              label: 'GPT-5.1 Codex',                provider: 'openai',    tag: 'code' },
  { id: 'gpt-5.1-codex-max',          label: 'GPT-5.1 Codex Max',            provider: 'openai',    tag: 'code' },
  { id: 'gpt-5.2-codex',              label: 'GPT-5.2 Codex',                provider: 'openai',    tag: 'code' },
  { id: 'gpt-5.3-codex',              label: 'GPT-5.3 Codex',                provider: 'openai',    tag: 'code' },
];

export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6-thinking';
