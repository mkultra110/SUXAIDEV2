import { useMemo, useState } from 'react';
import { Spinner } from '../ui/Spinner';
import { CodeBlock } from './CodeBlock';
import { renderMarkdown } from '../../lib/markdown';
import './Message.css';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** What we render in the chat — clean, no embedded file dumps. */
  content: string;
  /** What we send to the model in `history`. Contains attachments,
   *  @mention file dumps and any other context the user added when
   *  they sent the message, so follow-up turns don't lose track of
   *  the docs the conversation is about. Defaults to `content`. */
  historyContent?: string;
  command?: 'explain' | 'refactor' | 'fix' | 'optimize' | 'edit' | 'chat';
  streaming?: boolean;
  error?: string;
  modelId?: string;
  /** Files this user message attached. Used to re-attach context when
   *  the user regenerates a reply. */
  attachments?: { path: string; name: string; content: string }[];
}

interface Props {
  message: ChatMessage;
  onApply?: (code: string) => void;
  onDiff?: (code: string) => void;
  onCopy?: (msg: ChatMessage) => void;
  onRegenerate?: (msg: ChatMessage) => void;
  onDelete?: (msg: ChatMessage) => void;
}

interface Part {
  kind: 'text' | 'code';
  content: string;
  language?: string;
}

function parseMarkdown(text: string): Part[] {
  const parts: Part[] = [];
  // Match closed fences first.
  const closed = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = closed.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ kind: 'text', content: text.slice(last, match.index) });
    }
    parts.push({ kind: 'code', content: match[2], language: match[1] || 'plaintext' });
    last = closed.lastIndex;
  }
  // Handle a trailing UNCLOSED fence (mid-stream): render the partial
  // body as a code block so the user sees the incoming code as code,
  // not as malformed prose.
  if (last < text.length) {
    const tail = text.slice(last);
    const open = /```([a-zA-Z0-9_-]*)\n([\s\S]*)$/.exec(tail);
    if (open) {
      const before = tail.slice(0, open.index);
      if (before) parts.push({ kind: 'text', content: before });
      parts.push({ kind: 'code', content: open[2], language: open[1] || 'plaintext' });
    } else {
      parts.push({ kind: 'text', content: tail });
    }
  }
  return parts;
}

export function Message({
  message,
  onApply,
  onDiff,
  onCopy,
  onRegenerate,
  onDelete,
}: Props) {
  const parts = useMemo(() => parseMarkdown(message.content), [message.content]);
  const [copied, setCopied] = useState(false);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
      onCopy?.(message);
    } catch {
      /* ignore */
    }
  };

  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble msg__bubble--user">
          {message.command && message.command !== 'chat' && (
            <span className={`msg__cmd msg__cmd--${message.command}`}>{message.command}</span>
          )}
          <div className="msg__text msg__text--plain">{message.content}</div>
          <div className="msg__actions msg__actions--user">
            <button
              type="button"
              className="msg__action"
              onClick={copyAll}
              title={copied ? 'Copied' : 'Copy'}
            >
              {copied ? '✓' : '⧉'}
            </button>
            {onDelete && (
              <button
                type="button"
                className="msg__action"
                onClick={() => onDelete(message)}
                title="Delete this message"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const empty = parts.length === 0;
  const lastPartIdx = parts.length - 1;

  return (
    <div className="msg msg--assistant">
      <div className="msg__avatar" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2 L14 9 L21 11 L14 13 L12 21 L10 13 L3 11 L10 9 Z"
            fill="currentColor"
          />
        </svg>
      </div>
      <div className="msg__body">
        <div className="msg__head">
          <span className="msg__role">Assistant</span>
          {message.modelId && <span className="msg__model">{message.modelId}</span>}
          {message.streaming && <Spinner size={10} />}
          <div className="msg__actions">
            <button
              type="button"
              className="msg__action"
              onClick={copyAll}
              title={copied ? 'Copied' : 'Copy whole reply'}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            {onRegenerate && !message.streaming && (
              <button
                type="button"
                className="msg__action"
                onClick={() => onRegenerate(message)}
                title="Regenerate this reply"
              >
                ↻
              </button>
            )}
            {onDelete && !message.streaming && (
              <button
                type="button"
                className="msg__action"
                onClick={() => onDelete(message)}
                title="Delete this reply"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="msg__content">
          {empty && message.streaming && (
            <div className="msg__thinking" aria-live="polite">
              <span className="msg__thinking-dot" />
              <span className="msg__thinking-dot" />
              <span className="msg__thinking-dot" />
            </div>
          )}
          {parts.map((p, i) => {
            const isLast = i === lastPartIdx;
            const showCursor = !!message.streaming && isLast;
            if (p.kind === 'code') {
              return (
                <CodeBlock
                  key={i}
                  code={p.content}
                  language={p.language ?? 'plaintext'}
                  onApply={onApply}
                  onDiff={onDiff}
                  streaming={showCursor}
                />
              );
            }
            return (
              <div
                key={i}
                className={`msg__text ${showCursor ? 'msg__text--streaming' : ''}`}
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(p.content),
                }}
              />
            );
          })}
        </div>
        {message.error && <div className="msg__error">⚠ {message.error}</div>}
      </div>
    </div>
  );
}
