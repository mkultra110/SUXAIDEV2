import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { diffLines } from 'diff';
import { Button } from '../ui/Button';
import type { ToolCall } from '../../lib/agent';
import { detectDangerousCommand } from '../../lib/agent';
import './ApprovalDialog.css';

export interface ApprovalRequest {
  call: ToolCall;
  preview?: {
    path: string;
    original: string;
    proposed: string;
  };
  resolve: (approved: boolean) => void;
}

interface Props {
  request: ApprovalRequest | null;
}

export function ApprovalDialog({ request }: Props) {
  useEffect(() => {
    if (!request) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        request.resolve(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        request.resolve(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [request]);

  const diffHunks = useMemo(() => {
    if (!request?.preview) return null;
    const { original, proposed } = request.preview;
    if (original === proposed) return null;
    const changes = diffLines(original, proposed);
    return changes;
  }, [request]);

  if (!request) return null;

  const { call, preview } = request;
  const args = (call.input ?? {}) as Record<string, unknown>;
  const isCommand = call.name === 'run_command';
  const commandText = isCommand ? String(args.command ?? '') : '';
  const dangerous = isCommand && detectDangerousCommand(commandText);

  return createPortal(
    <div
      className="approval__overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => request.resolve(false)}
    >
      <div className="approval__card glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="approval__head">
          <span className={`approval__badge approval__badge--${dangerous ? 'danger' : call.name}`}>
            {dangerous ? '⚠ danger' : call.name}
          </span>
          <span className="approval__title">
            {labelFor(call.name)}
          </span>
        </div>

        {preview && (
          <div className="approval__path" title={preview.path}>
            {preview.path}
          </div>
        )}

        {call.name === 'run_command' && (
          <pre className="approval__cmd">
            <code>{commandText}</code>
            {typeof args.cwd === 'string' && args.cwd ? (
              <div className="approval__cmd-meta">cwd: {String(args.cwd)}</div>
            ) : null}
          </pre>
        )}

        {diffHunks && diffHunks.length > 0 && (
          <div className="approval__diff">
            {diffHunks.map((c, i) => (
              <pre
                key={i}
                className={`approval__diff-block ${
                  c.added ? 'approval__diff-block--add' : c.removed ? 'approval__diff-block--del' : ''
                }`}
              >
                <code>{c.value}</code>
              </pre>
            ))}
          </div>
        )}

        {dangerous && (
          <div className="approval__warn">
            This command matches a known destructive pattern. Review it carefully before
            approving.
          </div>
        )}

        <div className="approval__actions">
          <Button variant="ghost" size="md" onClick={() => request.resolve(false)}>
            Reject <kbd className="approval__kbd">Esc</kbd>
          </Button>
          <Button
            variant={dangerous ? 'secondary' : 'primary'}
            size="md"
            onClick={() => request.resolve(true)}
          >
            {dangerous ? 'Approve anyway' : 'Approve'}{' '}
            <kbd className="approval__kbd">⌘↵</kbd>
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function labelFor(name: string): string {
  switch (name) {
    case 'edit_file':
      return 'Apply this edit?';
    case 'write_file':
      return 'Create / overwrite this file?';
    case 'run_command':
      return 'Run this command?';
    default:
      return `Approve ${name}?`;
  }
}
