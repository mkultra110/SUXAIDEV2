import { API_BASE_URL } from '../config';

export type AiCommand = 'explain' | 'refactor' | 'fix' | 'chat';

export interface AiRequest {
  modelId: string;
  command: AiCommand;
  prompt: string;
  context?: {
    filePath?: string;
    language?: string;
    fileContent?: string;
    selection?: string;
  };
}

export interface AiStreamHandlers {
  onToken?: (chunk: string) => void;
  onDone?: (full: string) => void;
  onError?: (err: Error) => void;
}

/**
 * Streams an AI completion from the VPS proxy (/ai/chat).
 * The VPS holds the Quatarly API key and forwards the request.
 * Returns an abort function.
 */
export function streamAi(
  token: string,
  req: AiRequest,
  handlers: AiStreamHandlers,
): () => void {
  const controller = new AbortController();
  const url = `${API_BASE_URL}/ai/chat`;

  (async () => {
    let full = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`AI request failed (${res.status}): ${text.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Parse lines: `data: {"delta": "..."}\n\n` and `data: [DONE]\n\n`
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            handlers.onDone?.(full);
            return;
          }
          let obj: { delta?: string; error?: string } | null = null;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (obj?.error) throw new Error(obj.error);
          if (obj?.delta) {
            full += obj.delta;
            handlers.onToken?.(obj.delta);
          }
        }
      }
      handlers.onDone?.(full);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      handlers.onError?.(err as Error);
    }
  })();

  return () => controller.abort();
}

export function buildCommandPrompt(command: AiCommand, userText: string): string {
  switch (command) {
    case 'explain':
      return `Explain the selected code clearly and concisely. Highlight non-obvious behavior.\n\n${userText}`;
    case 'refactor':
      return `Refactor the selected code for readability and maintainability without changing behavior. Return the final code in a single fenced block, then a short changelog.\n\n${userText}`;
    case 'fix':
      return `Identify bugs in the selected code and propose a fix. Return corrected code in a fenced block, then explain the fix.\n\n${userText}`;
    case 'chat':
    default:
      return userText;
  }
}
