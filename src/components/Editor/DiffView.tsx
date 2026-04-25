import { useMemo, useState, useCallback } from 'react';
import { diffLines, type Change } from 'diff';
import { useWorkspace, type PendingDiff } from '../../contexts/WorkspaceContext';
import { Button } from '../ui/Button';
import './DiffView.css';

/**
 * A "hunk" is a contiguous run of changed lines, optionally preceded by
 * a short equal-context block. Each hunk can be individually accepted
 * (apply the added lines, drop the removed lines) or rejected (keep the
 * removed lines, drop the added lines).
 */
interface Hunk {
  id: string;
  contextBefore: string[];
  removed: string[];
  added: string[];
  /** null = undecided, 'accept' = take new, 'reject' = keep original */
  decision: 'accept' | 'reject' | null;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // diffLines adds a trailing '\n' to every Change.value except possibly
  // the last. We normalise so every entry of the array is a line WITHOUT
  // trailing newline; we'll rejoin with '\n' at the end.
  return text.replace(/\n$/, '').split('\n');
}

function buildHunks(changes: Change[]): Hunk[] {
  const hunks: Hunk[] = [];
  let ctx: string[] = [];
  let id = 0;

  const MAX_CONTEXT = 3;

  const flush = (removed: string[], added: string[]) => {
    if (removed.length === 0 && added.length === 0) return;
    hunks.push({
      id: String(id++),
      contextBefore: ctx.slice(-MAX_CONTEXT),
      removed,
      added,
      decision: null,
    });
    ctx = [];
  };

  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    const lines = splitLines(ch.value);
    if (!ch.added && !ch.removed) {
      // Unchanged — becomes context for the next hunk.
      ctx.push(...lines);
      continue;
    }
    // Collect the contiguous run of added/removed changes.
    const removed: string[] = [];
    const added: string[] = [];
    if (ch.removed) removed.push(...lines);
    else added.push(...lines);
    while (i + 1 < changes.length && (changes[i + 1].added || changes[i + 1].removed)) {
      const nxt = changes[++i];
      const nls = splitLines(nxt.value);
      if (nxt.removed) removed.push(...nls);
      else added.push(...nls);
    }
    flush(removed, added);
  }

  return hunks;
}

/**
 * Apply the hunks' decisions against the original source to produce the
 * final merged content. For undecided hunks we default to REJECT (keep
 * original) — users have to explicitly accept.
 */
function materialize(changes: Change[], hunks: Hunk[]): string {
  let hunkIdx = 0;
  const out: string[] = [];

  for (let i = 0; i < changes.length; i++) {
    const ch = changes[i];
    if (!ch.added && !ch.removed) {
      out.push(...splitLines(ch.value));
      continue;
    }
    // Collect the run of changed blocks like buildHunks did, but apply.
    const removed: string[] = [];
    const added: string[] = [];
    if (ch.removed) removed.push(...splitLines(ch.value));
    else added.push(...splitLines(ch.value));
    while (i + 1 < changes.length && (changes[i + 1].added || changes[i + 1].removed)) {
      const nxt = changes[++i];
      if (nxt.removed) removed.push(...splitLines(nxt.value));
      else added.push(...splitLines(nxt.value));
    }
    const decision = hunks[hunkIdx++]?.decision ?? 'reject';
    if (decision === 'accept') {
      out.push(...added);
    } else {
      out.push(...removed);
    }
  }
  return out.join('\n');
}

export function DiffView({ diff }: { diff: PendingDiff }) {
  const { closeDiff, openFile, activeFile, openFiles } = useWorkspace();
  const workspace = useWorkspace();

  const changes = useMemo(
    () => diffLines(diff.original, diff.proposed),
    [diff.original, diff.proposed],
  );

  const [hunks, setHunks] = useState<Hunk[]>(() => buildHunks(changes));

  const decide = useCallback(
    (id: string, decision: 'accept' | 'reject' | null) => {
      setHunks((hs) => hs.map((h) => (h.id === id ? { ...h, decision } : h)));
    },
    [],
  );

  const acceptAll = () =>
    setHunks((hs) => hs.map((h) => ({ ...h, decision: 'accept' })));
  const rejectAll = () =>
    setHunks((hs) => hs.map((h) => ({ ...h, decision: 'reject' })));

  const [busy, setBusy] = useState(false);
  const apply = () => {
    if (busy) return; // double-click guard
    setBusy(true);
    try {
      const merged = materialize(changes, hunks);
      // Use the workspace state directly to apply the merged content.
      // Not every file in pendingDiff is guaranteed to be the active file
      // any more (e.g. user switched tabs while diffing). If the file is
      // still open, update its content; otherwise surface an open call.
      const target = openFiles.find((f) => f.path === diff.path) ?? activeFile;
      if (target) {
        openFile({ ...target, content: merged, dirty: true });
      }
      workspace.closeDiff();
    } finally {
      setBusy(false);
    }
  };

  const decidedCount = hunks.filter((h) => h.decision !== null).length;
  const hasChanges = hunks.length > 0;

  return (
    <div className="diffview">
      <div className="diffview__bar">
        <div className="diffview__title">
          <span className="diffview__badge">AI diff</span>
          <span className="diffview__file">{diff.path.split(/[\\/]/).pop()}</span>
          {diff.label && <span className="diffview__label">{diff.label}</span>}
          {hasChanges && (
            <span className="diffview__counter">
              {decidedCount} / {hunks.length} hunks decided
            </span>
          )}
        </div>
        <div className="diffview__actions">
          <Button variant="ghost" size="sm" onClick={rejectAll} disabled={!hasChanges}>
            Reject all
          </Button>
          <Button variant="ghost" size="sm" onClick={acceptAll} disabled={!hasChanges}>
            Accept all
          </Button>
          <Button variant="secondary" size="sm" onClick={closeDiff}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={apply} disabled={busy}>
            {busy ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </div>

      <div className="diffview__body">
        {!hasChanges ? (
          <div className="diffview__empty">No changes — original and proposed are identical.</div>
        ) : (
          hunks.map((hunk) => (
            <HunkBlock key={hunk.id} hunk={hunk} onDecide={(d) => decide(hunk.id, d)} />
          ))
        )}
      </div>
    </div>
  );
}

function HunkBlock({
  hunk,
  onDecide,
}: {
  hunk: Hunk;
  onDecide: (d: 'accept' | 'reject' | null) => void;
}) {
  const stateClass =
    hunk.decision === 'accept'
      ? 'diff-hunk--accepted'
      : hunk.decision === 'reject'
        ? 'diff-hunk--rejected'
        : '';

  return (
    <div className={`diff-hunk ${stateClass}`}>
      <div className="diff-hunk__context">
        {hunk.contextBefore.map((line, i) => (
          <div key={i} className="diff-hunk__line diff-hunk__line--context">
            <span className="diff-hunk__gutter"> </span>
            <span className="diff-hunk__text">{line || ' '}</span>
          </div>
        ))}
      </div>
      <div className="diff-hunk__changes">
        {hunk.removed.map((line, i) => (
          <div key={`r-${i}`} className="diff-hunk__line diff-hunk__line--removed">
            <span className="diff-hunk__gutter">-</span>
            <span className="diff-hunk__text">{line || ' '}</span>
          </div>
        ))}
        {hunk.added.map((line, i) => (
          <div key={`a-${i}`} className="diff-hunk__line diff-hunk__line--added">
            <span className="diff-hunk__gutter">+</span>
            <span className="diff-hunk__text">{line || ' '}</span>
          </div>
        ))}
      </div>
      <div className="diff-hunk__toolbar">
        <button
          type="button"
          className={`diff-hunk__btn diff-hunk__btn--reject ${hunk.decision === 'reject' ? 'is-active' : ''}`}
          onClick={() => onDecide(hunk.decision === 'reject' ? null : 'reject')}
          title="Keep the original lines for this hunk"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          Reject
        </button>
        <button
          type="button"
          className={`diff-hunk__btn diff-hunk__btn--accept ${hunk.decision === 'accept' ? 'is-active' : ''}`}
          onClick={() => onDecide(hunk.decision === 'accept' ? null : 'accept')}
          title="Apply the new lines for this hunk"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M4 12l5 5 11-12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Accept
        </button>
      </div>
    </div>
  );
}
