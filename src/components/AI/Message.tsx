import { useEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '../ui/Spinner';
import { CodeBlock } from './CodeBlock';
import { ToolCall } from './ToolCall';
import { EditedFilesPanel } from './EditedFilesPanel';
import { renderMarkdown } from '../../lib/markdown';
import './Message.css';

export interface ToolCallSnapshot {
  id: string;
  name: string;
  input: unknown;
  status: 'pending' | 'running' | 'done' | 'error' | 'rejected';
  /** Stringified result (or error message) once the tool has run. */
  result?: string;
  /** v3.19 — diff preview for `edit_file` / `write_file`. Captured
   *  at approval time (requestApproval onResolve in AIPanel) so the
   *  ToolCall card can render colorized hunks inline in the chat,
   *  Cursor-style. Both fields are full file content (pre/post). */
  diffPreview?: {
    original: string;
    proposed: string;
  };
}

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
  /** Agent-mode tool calls emitted by this assistant turn. */
  toolCalls?: ToolCallSnapshot[];
  /** v0.12: extended-thinking and server-side blocks captured during
   *  streaming. Stored in arrival order so we can prepend them to
   *  `toolCalls` when reconstructing the assistant turn for the next
   *  agent-mode request — the cryptographic `signature` on each
   *  thinking block must round-trip byte-for-byte or Anthropic
   *  returns 400 "Expected thinking or redacted_thinking block".
   *  Non-thinking models never populate this array. */
  assistantBlocks?: Array<
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string }
    | { type: 'server_tool_use'; id: string; name: string; input: unknown }
  >;
  /** Set when an assistant code block has been auto-routed into the
   *  inline diff view on a real file. The renderer hides the first
   *  fenced code block and shows a "Open in editor" chip pointing at
   *  this path instead — so the user doesn't see a wall of code AND
   *  a diff for the same change. */
  divertedToFile?: string;
  /** Checkpoint id stamped on a user message that triggered an agent
   *  turn. Lets us render a "Restore" button that rolls every snapshotted
   *  file back to its pre-turn content via window.suxai.checkpoint.restore.
   */
  checkpointId?: string;
  /** v4.3.1 — round agent en cours (live-updated pendant le stream).
   *  Affiché à côté du spinner pour que le user voit que le model
   *  enchaîne plusieurs rounds tool_use plutôt que de croire qu'il
   *  est planté ou qu'il « relance des modifs sans qu'on demande ».
   *  Disparaît au end_turn (streaming → false). */
  agentIteration?: { current: number; max: number };
}

interface Props {
  message: ChatMessage;
  onApply?: (code: string) => void;
  onDiff?: (code: string) => void;
  onCopy?: (msg: ChatMessage) => void;
  onRegenerate?: (msg: ChatMessage) => void;
  onDelete?: (msg: ChatMessage) => void;
  /** Called when the user clicks the Restore button on a user
   *  message tagged with a checkpointId. Implementation lives in
   *  AIPanel and rolls back every file snapshotted before the turn. */
  onRestoreCheckpoint?: (checkpointId: string) => void;
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
  onRestoreCheckpoint,
}: Props) {
  const parts = useMemo(() => parseMarkdown(message.content), [message.content]);
  const [copied, setCopied] = useState(false);
  // v4.3.2 — track le timeout pour pouvoir le clear si le composant
  // unmount avant les 1200ms (sinon setState sur composant mort →
  // warning React + petit memory leak qui s'accumule sur les longues
  // sessions de chat).
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
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
            {message.checkpointId && onRestoreCheckpoint && (
              <button
                type="button"
                className="msg__action msg__action--restore"
                onClick={() => onRestoreCheckpoint(message.checkpointId!)}
                title="Restore the workspace to its state right before this turn"
              >
                ↶ Restore
              </button>
            )}
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
          {/* v4.3.1 — round agent en cours. Visible uniquement pendant
              le stream et seulement si le model a chaîné au moins 2
              rounds (round 1 silencieux pour éviter le bruit visuel
              sur les requêtes simples qui terminent en un seul round). */}
          {message.streaming && message.agentIteration && message.agentIteration.current > 1 && (
            <span className="msg__iter" title={`Agent round ${message.agentIteration.current} of max ${message.agentIteration.max}`}>
              round {message.agentIteration.current}/{message.agentIteration.max}
            </span>
          )}
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
          {/* v0.12.2: extended-thinking summary. The *-thinking models
              emit one or more thinking blocks before any text/tool_use;
              showing them collapsed lets the user audit the reasoning
              without flooding the chat. Redacted blocks render as a
              short placeholder — Anthropic ships them when the chain
              of thought is too sensitive to disclose. */}
          {message.assistantBlocks && message.assistantBlocks.length > 0 && (
            <ThinkingPanel blocks={message.assistantBlocks} />
          )}
          {empty && message.streaming && (
            <div className="msg__thinking" aria-live="polite">
              <span className="msg__thinking-dot" />
              <span className="msg__thinking-dot" />
              <span className="msg__thinking-dot" />
            </div>
          )}
          {(() => {
            // When the message has been diverted to the inline diff,
            // hide the FIRST code block (the model's wall-of-code
            // proposal) behind a small "Open in editor" chip pointing
            // at the file. Subsequent code blocks (small examples) and
            // the surrounding prose still render normally.
            let firstCodeReplaced = false;
            return parts.map((p, i) => {
              const isLast = i === lastPartIdx;
              const showCursor = !!message.streaming && isLast;
              if (p.kind === 'code') {
                if (message.divertedToFile && !firstCodeReplaced) {
                  firstCodeReplaced = true;
                  return (
                    <DivertedChip
                      key={`${message.id}:diverted:${i}`}
                      path={message.divertedToFile}
                    />
                  );
                }
                return (
                  <CodeBlock
                    key={`${message.id}:${p.kind}:${i}`}
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
                  key={`${message.id}:${p.kind}:${i}`}
                  className={`msg__text ${showCursor ? 'msg__text--streaming' : ''}`}
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(p.content),
                  }}
                />
              );
            });
          })()}
        </div>
        {message.toolCalls && message.toolCalls.length > 0 && (
          <>
            <EditedFilesPanel message={message} />
            <div className="msg__tools">
              {message.toolCalls.map((tc) => (
                <ToolCall key={tc.id} call={tc} />
              ))}
            </div>
          </>
        )}
        {message.error && <div className="msg__error">⚠ {message.error}</div>}
      </div>
    </div>
  );
}


/**
 * Collapsible reasoning panel for *-thinking models. Defaults to
 * collapsed — once the user has acted on the assistant's tool calls
 * the chain-of-thought is rarely interesting again, but a click
 * away if they want to inspect it.
 */
function ThinkingPanel({
  blocks,
}: {
  blocks: NonNullable<ChatMessage['assistantBlocks']>;
}) {
  const [open, setOpen] = useState(false);
  const thinking = blocks.filter((b) => b.type === 'thinking') as Array<{
    type: 'thinking';
    thinking: string;
    signature: string;
  }>;
  const redactedCount = blocks.filter((b) => b.type === 'redacted_thinking').length;
  if (thinking.length === 0 && redactedCount === 0) return null;
  const totalChars = thinking.reduce((acc, b) => acc + b.thinking.length, 0);
  return (
    <div className={`msg__reasoning ${open ? 'msg__reasoning--open' : ''}`}>
      <button
        type="button"
        className="msg__reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        <span>
          🧠 Réflexion
          {totalChars > 0 ? ` (${Math.max(1, Math.round(totalChars / 1000))}K caractères)` : ''}
          {redactedCount > 0 ? ` · ${redactedCount} bloc${redactedCount > 1 ? 's' : ''} censuré${redactedCount > 1 ? 's' : ''}` : ''}
        </span>
      </button>
      {open && (
        <div className="msg__reasoning-body">
          {thinking.map((b, i) => (
            <pre key={i} className="msg__reasoning-text">{b.thinking}</pre>
          ))}
          {redactedCount > 0 && (
            <div className="msg__reasoning-redacted">
              {redactedCount} bloc{redactedCount > 1 ? 's' : ''} de réflexion masqué{redactedCount > 1 ? 's' : ''} par Anthropic (politique de sûreté).
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DivertedChip({ path }: { path: string }) {
  const name = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="msg__diverted" title={path}>
      <span className="msg__diverted-icon" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          {/* REFACTOR-NOTE: green checkmark on summary icon — semantic
              success colour, kept inline because the SVG path needs a
              different stroke than its parent's currentColor. */}
          <path d="M16 16l3 3 5-5" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="msg__diverted-body">
        <div className="msg__diverted-title">Modifications proposées dans l'éditeur</div>
        <div className="msg__diverted-path">{name}</div>
      </div>
      <span className="msg__diverted-hint">Accept Alt+↵ · Reject Shift+Alt+⌫</span>
    </div>
  );
}
