import { useMemo, useState } from 'react';
import { diffLines } from 'diff';
import type { ToolCallSnapshot } from './Message';
import { AtelierIcon } from '../ui/AtelierIcon';
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
  // v3.19 — auto-expand pour les edit/write avec diffPreview, c'est
  // le contenu intéressant que le user veut voir tout de suite
  // (Cursor-style). Le user peut toggle pour collapse s'il veut.
  const hasDiff = !!call.diffPreview;
  const [open, setOpen] = useState(hasDiff);

  const args = call.input && typeof call.input === 'object'
    ? (call.input as Record<string, unknown>)
    : {};
  const headline = summarizeCall(call.name, args);

  return (
    <div className={`toolcall toolcall--${call.status}${hasDiff ? ' toolcall--withdiff' : ''}`}>
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
        {call.diffPreview && (
          <DiffStats
            original={call.diffPreview.original}
            proposed={call.diffPreview.proposed}
          />
        )}
        <span className={`toolcall__status toolcall__status--${call.status}`}>
          {STATUS_LABEL[call.status]}
        </span>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--dur-quick) var(--ease-out-expo)',
            opacity: 0.6,
          }}
        >
          <AtelierIcon name="i-chevron-down" size={10} />
        </span>
      </button>

      {open && (
        <div className="toolcall__body">
          {call.diffPreview ? (
            <DiffView
              original={call.diffPreview.original}
              proposed={call.diffPreview.proposed}
              path={typeof args.path === 'string' ? args.path : ''}
            />
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * v3.19 — Cursor-style diff render. Uses jsdiff `diffLines` to
 * compute change blocks, renders added lines green-tinted, removed
 * lines red-tinted, unchanged lines as 2 lines of context (head +
 * tail) with a `…` collapse for blocks > 4 lines. Click on the
 * file path header → reveal in editor.
 */
function DiffView({
  original,
  proposed,
  path,
}: {
  original: string;
  proposed: string;
  path: string;
}) {
  const blocks = useMemo(
    () => collapseUnchanged(diffLines(original, proposed)),
    [original, proposed],
  );
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return (
    <div className="toolcall__diff">
      {path && (
        <button
          type="button"
          className="toolcall__diff-path"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent<{ path: string }>('suxai:reveal-in-sidebar', {
                detail: { path },
              }),
            );
          }}
          title={path}
        >
          <AtelierIcon name="i-file-code" size={11} />
          {fileName}
        </button>
      )}
      <div className="toolcall__diff-body">
        {blocks.map((b, i) =>
          b.kind === 'omitted' ? (
            <div key={i} className="toolcall__diff-omit">
              … {b.lines} lines unchanged …
            </div>
          ) : (
            <div
              key={i}
              className={`toolcall__diff-line toolcall__diff-line--${b.kind}`}
            >
              <span className="toolcall__diff-marker" aria-hidden>
                {b.kind === 'add' ? '+' : b.kind === 'del' ? '−' : ' '}
              </span>
              <span className="toolcall__diff-text">{b.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

interface DiffBlock {
  kind: 'add' | 'del' | 'ctx' | 'omitted';
  text: string;
  lines: number;
}

/** Take jsdiff Change[] and turn it into displayable blocks :
 *  - Each added/removed line is its own block
 *  - Unchanged blocks > 4 lines collapse to 2 head + 2 tail with
 *    an «…N lines unchanged…» marker in the middle
 */
function collapseUnchanged(changes: Array<{ value: string; added?: boolean; removed?: boolean }>): DiffBlock[] {
  const out: DiffBlock[] = [];
  for (const ch of changes) {
    const lines = ch.value.split('\n');
    // Drop empty trailing line from split if value ends with \n
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (ch.added) {
      for (const ln of lines) out.push({ kind: 'add', text: ln, lines: 1 });
    } else if (ch.removed) {
      for (const ln of lines) out.push({ kind: 'del', text: ln, lines: 1 });
    } else {
      // Context. If block > 4 lines, collapse middle.
      if (lines.length <= 4) {
        for (const ln of lines) out.push({ kind: 'ctx', text: ln, lines: 1 });
      } else {
        out.push({ kind: 'ctx', text: lines[0], lines: 1 });
        out.push({ kind: 'ctx', text: lines[1], lines: 1 });
        out.push({ kind: 'omitted', text: '', lines: lines.length - 4 });
        out.push({ kind: 'ctx', text: lines[lines.length - 2], lines: 1 });
        out.push({ kind: 'ctx', text: lines[lines.length - 1], lines: 1 });
      }
    }
  }
  return out;
}

function DiffStats({ original, proposed }: { original: string; proposed: string }) {
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const ch of diffLines(original, proposed)) {
      const lineCount = ch.value.split('\n').length - (ch.value.endsWith('\n') ? 1 : 0);
      if (ch.added) added += lineCount;
      else if (ch.removed) removed += lineCount;
    }
    return { added, removed };
  }, [original, proposed]);
  return (
    <span className="toolcall__diffstats">
      <span className="toolcall__diffstats-add">+{stats.added}</span>
      <span className="toolcall__diffstats-del">−{stats.removed}</span>
    </span>
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
