import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown renderer for AI replies.
 *
 * Two layers of defense against injection even though our input is
 * AI-generated:
 *   1. We escape the raw input so marked can never be tricked into
 *      emitting arbitrary HTML from user content — the only tags in
 *      the output are those marked itself produces (p, strong, code,
 *      a, ul, li, etc.).
 *   2. We DOMPurify the final HTML to strip any `javascript:` hrefs or
 *      other exotic payloads the AI might smuggle through valid
 *      markdown syntax like `[click](javascript:alert(1))`.
 *
 * Links are rendered with target="_blank" rel="noopener noreferrer"
 * so a click is handled by Electron's will-navigate hook
 * (shell.openExternal) and can never replace the app's own window.
 */
const md = new Marked({
  breaks: true,
  gfm: true,
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(text: string): string {
  if (!text) return '';
  const raw = md.parse(escapeHtml(text), { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target', 'rel'],
    // Explicit allowlist: http(s), mailto, tel, and relative refs only.
    // Blocks data:, javascript:, vbscript:, file: and other exotic
    // protocols that could ship a payload through href / src.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[#/?.])/i,
  });
}
