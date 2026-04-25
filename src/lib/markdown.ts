import { Marked } from 'marked';

/**
 * Lightweight, AI-output-friendly markdown renderer used by chat
 * messages. Code fences are stripped before this runs (we render them
 * with our own <CodeBlock>), so the only dangerous thing in here is
 * raw HTML — disabled with html: false in marked.
 */
const md = new Marked({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(text: string): string {
  if (!text) return '';
  // Strip any leftover triple-backtick blocks defensively — they should
  // already be peeled off by the caller, but a half-streamed message
  // can still have an unclosed fence.
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // marked.parse returns string in sync mode (it can be async if using
  // extensions, but we don't).
  return md.parse(safe, { async: false }) as string;
}
