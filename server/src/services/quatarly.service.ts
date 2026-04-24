import { env } from '../config/env.js';
import { findModel, type AiRequestInput } from '../schemas/ai.js';

export interface StreamHandlers {
  onDelta: (chunk: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

function buildSystemPrompt(command: AiRequestInput['command']): string {
  const base =
    'You are SUXAI, a senior AI software engineer embedded in an IDE. ' +
    'Be precise and concise. When returning code, use fenced code blocks. ' +
    'Never repeat the entire file unless asked.';
  switch (command) {
    case 'explain':
      return `${base} Your task: explain the provided code clearly.`;
    case 'refactor':
      return `${base} Your task: refactor for readability and maintainability, keeping behavior identical. Return the complete refactored snippet in one code block followed by a short changelog.`;
    case 'fix':
      return `${base} Your task: find bugs and propose a fix. Return corrected code in one block, then a brief explanation.`;
    case 'optimize':
      return `${base} Your task: optimize for performance and memory while keeping the public API and behavior unchanged. Return the full optimized snippet in one fenced block, then a short list of the applied optimizations.`;
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
  const body = {
    model: modelId,
    stream: true,
    messages: [
      { role: 'system', content: buildSystemPrompt(req.command) },
      { role: 'user', content: buildUserContent(req) },
    ],
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
  const body = {
    model: modelId,
    max_tokens: 2048,
    stream: true,
    system: buildSystemPrompt(req.command),
    messages: [{ role: 'user', content: buildUserContent(req) }],
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
        if (!payload) continue;
        try {
          const obj = JSON.parse(payload);
          // Anthropic streaming — content_block_delta events.
          if (obj.type === 'content_block_delta') {
            const delta = obj.delta?.text;
            if (typeof delta === 'string' && delta.length > 0) h.onDelta(delta);
          } else if (obj.type === 'message_stop') {
            h.onDone();
            return;
          } else if (obj.type === 'error') {
            throw new Error(obj.error?.message ?? 'Anthropic stream error');
          }
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
    h.onDone();
  } catch (err) {
    h.onError(err as Error);
  }
}
