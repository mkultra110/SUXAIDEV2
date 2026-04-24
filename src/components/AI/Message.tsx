import { useMemo } from 'react';
import { Spinner } from '../ui/Spinner';
import { CodeBlock } from './CodeBlock';
import './Message.css';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  command?: 'explain' | 'refactor' | 'fix' | 'chat';
  streaming?: boolean;
  error?: string;
  modelId?: string;
}

interface Props {
  message: ChatMessage;
  onApply?: (code: string) => void;
}

interface Part {
  kind: 'text' | 'code';
  content: string;
  language?: string;
}

function parseMarkdown(text: string): Part[] {
  const parts: Part[] = [];
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push({ kind: 'text', content: text.slice(last, match.index) });
    }
    parts.push({ kind: 'code', content: match[2], language: match[1] || 'plaintext' });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ kind: 'text', content: text.slice(last) });
  // If message is still streaming and has an open fence, show the partial as code.
  return parts;
}

export function Message({ message, onApply }: Props) {
  const parts = useMemo(() => parseMarkdown(message.content), [message.content]);

  if (message.role === 'user') {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble msg__bubble--user">
          {message.command && message.command !== 'chat' && (
            <span className={`msg__cmd msg__cmd--${message.command}`}>{message.command}</span>
          )}
          <div className="msg__text">{message.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg--assistant">
      <div className="msg__avatar" aria-hidden>AI</div>
      <div className="msg__body">
        <div className="msg__head">
          <span className="msg__role">Assistant</span>
          {message.modelId && <span className="msg__model">{message.modelId}</span>}
          {message.streaming && <Spinner size={10} />}
        </div>
        <div className="msg__content">
          {parts.length === 0 && message.streaming && (
            <div className="msg__thinking">Thinking…</div>
          )}
          {parts.map((p, i) =>
            p.kind === 'code' ? (
              <CodeBlock key={i} code={p.content} language={p.language ?? 'plaintext'} onApply={onApply} />
            ) : (
              <div key={i} className="msg__text">{renderInline(p.content)}</div>
            ),
          )}
        </div>
        {message.error && <div className="msg__error">⚠ {message.error}</div>}
      </div>
    </div>
  );
}

function renderInline(text: string) {
  // Minimal inline code + bold support without a full markdown renderer.
  const nodes: (string | JSX.Element)[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(<code key={i++} className="msg__inline-code">{m[1]}</code>);
    else if (m[2]) nodes.push(<strong key={i++}>{m[2]}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes.map((n, idx) => (typeof n === 'string' ? <span key={idx}>{n}</span> : n))}</>;
}
