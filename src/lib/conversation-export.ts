/**
 * v3.18 — Conversation export to Markdown / JSON.
 *
 * Useful for : sharing a debugging session, archiving an interesting
 * agent run, copying a snippet of context to another tool. The
 * Markdown format is human-readable + GitHub-pasteable ; the JSON
 * format is the lossless round-trip (re-importable in a future
 * version).
 */

import type { Conversation } from './conversations';
import type { ChatMessage, ToolCallSnapshot } from '../components/AI/Message';

function fmtTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function clipResult(s: string, max = 1500): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[…truncated, ${s.length - max} chars]`;
}

function mdToolCall(tc: ToolCallSnapshot): string {
  const input = (() => {
    try { return JSON.stringify(tc.input, null, 2); }
    catch { return '<unserialisable>'; }
  })();
  const result = tc.result ? `\n\n_Result_ :\n\n\`\`\`\n${clipResult(tc.result)}\n\`\`\`` : '';
  const status = tc.status === 'done' ? '✓' :
                 tc.status === 'error' ? '✗' :
                 tc.status === 'rejected' ? '⊘' :
                 tc.status === 'running' || tc.status === 'pending' ? '…' :
                 '?';
  return [
    `**${status} Tool : \`${tc.name}\`**`,
    '',
    '```json',
    input,
    '```',
    result,
  ].join('\n');
}

function mdMessage(m: ChatMessage): string {
  const head = m.role === 'user' ? '### 🧑 User' : `### 🤖 Assistant${m.modelId ? ` (${m.modelId})` : ''}`;
  const body = m.content?.trim() ? m.content : '_(empty)_';
  const blocks: string[] = [head, '', body];
  if (m.toolCalls && m.toolCalls.length > 0) {
    blocks.push('');
    for (const tc of m.toolCalls) {
      blocks.push(mdToolCall(tc));
      blocks.push('');
    }
  }
  if (m.error) {
    blocks.push('');
    blocks.push(`> ⚠️ Error : ${m.error}`);
  }
  return blocks.join('\n');
}

/** Serialise a conversation to Markdown. */
export function conversationToMarkdown(conv: Conversation): string {
  const out: string[] = [];
  out.push(`# ${conv.title || 'Untitled conversation'}`);
  out.push('');
  out.push(`_Started ${fmtTs(conv.createdAt)} · last updated ${fmtTs(conv.updatedAt)}_`);
  if (conv.mode) out.push(`_Mode : ${conv.mode}_`);
  out.push('');
  out.push('---');
  out.push('');
  for (const m of conv.messages) {
    out.push(mdMessage(m));
    out.push('');
    out.push('---');
    out.push('');
  }
  return out.join('\n');
}

/** Serialise a conversation to JSON (pretty-printed, 2-space). */
export function conversationToJson(conv: Conversation): string {
  return JSON.stringify(conv, null, 2) + '\n';
}

/** Build a filesystem-friendly slug from a conversation title. */
export function exportFilename(conv: Conversation, ext: 'md' | 'json'): string {
  const slug = (conv.title || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'conversation';
  const stamp = new Date().toISOString().slice(0, 10);
  return `${slug}-${stamp}.${ext}`;
}
