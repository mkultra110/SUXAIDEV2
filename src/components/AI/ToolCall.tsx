import { useState } from 'react';
import type { ToolCallSnapshot } from './Message';
import './ToolCall.css';

const TOOL_GLYPH: Record<string, string> = {
  read_file: '📄',
  list_dir: '📂',
  edit_file: '✏️',
  write_file: '➕',
};

const STATUS_LABEL: Record<ToolCallSnapshot['status'], string> = {
  pending: 'queued',
  running: 'running…',
  done: 'done',
  error: 'error',
  rejected: 'rejected',
};

export function ToolCall({ call }: { call: ToolCallSnapshot }) {
  const [open, setOpen] = useState(false);

  const args = call.input && typeof call.input === 'object'
    ? (call.input as Record<string, unknown>)
    : {};
  const headline = summarizeCall(call.name, args);

  return (
    <div className={`toolcall toolcall--${call.status}`}>
      <button
        type="button"
        className="toolcall__head"
        onClick={() => setOpen((o) => !o)}
        title="Click to expand"
      >
        <span className="toolcall__glyph" aria-hidden>
          {TOOL_GLYPH[call.name] ?? '🔧'}
        </span>
        <span className="toolcall__name">{call.name}</span>
        <span className="toolcall__headline" title={headline}>
          {headline}
        </span>
        <span className={`toolcall__status toolcall__status--${call.status}`}>
          {STATUS_LABEL[call.status]}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          style={{
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--dur-quick) var(--ease-out-expo)',
            opacity: 0.6,
          }}
        >
          <path
            d="M2 4 L5 7 L8 4"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="toolcall__body">
          <div className="toolcall__section">
            <div className="toolcall__section-label">Input</div>
            <pre className="toolcall__pre">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          {call.result !== undefined && (
            <div className="toolcall__section">
              <div className="toolcall__section-label">
                {call.status === 'error' ? 'Error' : 'Output'}
              </div>
              <pre className="toolcall__pre">
                {truncate(call.result, 4000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function summarizeCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file':
    case 'list_dir':
    case 'edit_file':
    case 'write_file':
      return typeof args.path === 'string' ? args.path : JSON.stringify(args);
    default:
      return JSON.stringify(args).slice(0, 80);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n\n[truncated — ${s.length - n} more chars]`;
}
