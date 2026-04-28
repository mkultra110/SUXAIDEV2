import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listBranches,
  checkoutBranch,
  type GitBranchInfo,
} from '../../lib/git';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useToast } from '../ui/Toast';
import { AtelierIcon } from '../ui/AtelierIcon';
import './BranchPicker.css';

/**
 * v0.16.16 — Branch picker modal.
 * Triggered from the status-bar branch indicator, the Source Control
 * header, or the Command Palette via the 'suxai:branch-picker-open'
 * CustomEvent. Lists local + remote branches, fuzzy-search by name,
 * ↑↓ Enter to checkout. Enter on no-match + non-empty query creates
 * a new branch from HEAD.
 */
const BRANCH_PICKER_OPEN_EVENT = 'suxai:branch-picker-open';

export function openBranchPicker(): void {
  window.dispatchEvent(new CustomEvent(BRANCH_PICKER_OPEN_EVENT));
}

interface Props {
  cwd: string | null;
  open: boolean;
  onClose: () => void;
}

function fuzzyScore(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastIdx = -1;
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] === q[qi]) {
      const atBoundary = i === 0 || /[/_\-. ]/.test(l[i - 1]);
      score += atBoundary ? 20 : 10 - (i - (lastIdx + 1));
      lastIdx = i;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/** v0.16.16 — singleton wrapper. Mount once at App level (inside
 *  the WorkspaceProvider so useWorkspace() resolves) ; any caller
 *  fires `openBranchPicker()` to surface it. */
export function BranchPickerHost() {
  const { workspaceRoot } = useWorkspace();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(BRANCH_PICKER_OPEN_EVENT, handler);
    return () => window.removeEventListener(BRANCH_PICKER_OPEN_EVENT, handler);
  }, []);
  return <BranchPicker cwd={workspaceRoot} open={open} onClose={() => setOpen(false)} />;
}

export function BranchPicker({ cwd, open, onClose }: Props) {
  const toast = useToast();
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load branches on open + workspaceRoot.
  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    void listBranches(cwd).then((list) => {
      if (cancelled) return;
      setBranches(list);
    });
    return () => { cancelled = true; };
  }, [open, cwd]);

  // Focus input on open.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  const filtered = useMemo<GitBranchInfo[]>(() => {
    const q = query.trim();
    // De-dupe : if a remote branch (origin/foo) has a corresponding
    // local branch with the same short name, hide the remote.
    const localNames = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));
    const visible = branches.filter((b) =>
      !b.isRemote || !localNames.has(b.name.replace(/^[^/]+\//, '')),
    );
    if (!q) return visible.slice(0, 200);
    return visible
      .map((b) => {
        const s = fuzzyScore(b.name, q);
        return s !== null ? { b, s } : null;
      })
      .filter((x): x is { b: GitBranchInfo; s: number } => x !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 200)
      .map((x) => x.b);
  }, [branches, query]);

  const exactMatch = filtered.some((b) => b.name === query.trim());

  useEffect(() => { setCursor(0); }, [query]);

  const pick = useCallback(
    async (branch: string, create: boolean) => {
      if (!cwd || busy) return;
      setBusy(true);
      const err = await checkoutBranch(cwd, branch, create);
      setBusy(false);
      if (err) {
        toast.error(create ? 'Create branch failed' : 'Checkout failed', err);
        return;
      }
      toast.success(create ? 'Created and switched' : 'Switched branch', branch);
      onClose();
    },
    [cwd, busy, toast, onClose],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = query.trim();
      // Shift+Enter or no exact match + non-empty → create new branch.
      if ((e.shiftKey || !exactMatch) && q.length > 0 && filtered.length === 0) {
        void pick(q, true);
      } else {
        const target = filtered[cursor];
        if (target) {
          // For a remote like origin/feature-x, checkout creates a
          // local tracking branch automatically.
          void pick(target.name, false);
        }
      }
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="bpk__overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bpk glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="bpk__head">
          <span className="bpk__head-icon" aria-hidden>
            <AtelierIcon name="i-git-branch" size={14} />
          </span>
          <input
            ref={inputRef}
            className="bpk__input"
            placeholder="Switch branch (type to filter, Enter on empty match = create)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
        </div>
        <div className="bpk__list">
          {!cwd ? (
            <div className="bpk__empty">No workspace open.</div>
          ) : filtered.length === 0 ? (
            <div className="bpk__empty">
              {query.trim().length > 0 ? (
                <>
                  No branch matches <code>{query.trim()}</code>. Press <kbd>Enter</kbd> to{' '}
                  <strong>create</strong> it from the current HEAD.
                </>
              ) : 'No branches found.'}
            </div>
          ) : (
            filtered.map((b, i) => (
              <button
                key={b.name + (b.isRemote ? ':r' : ':l')}
                type="button"
                className={`bpk__item ${i === cursor ? 'bpk__item--active' : ''} ${b.isCurrent ? 'bpk__item--current' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => void pick(b.name, false)}
              >
                <span className={`bpk__kind bpk__kind--${b.isRemote ? 'remote' : 'local'}`}>
                  {b.isRemote ? 'remote' : 'local'}
                </span>
                <span className="bpk__name">{b.name}</span>
                {b.isCurrent && <span className="bpk__here">current</span>}
                {b.upstream && !b.isRemote && (
                  <span className="bpk__upstream" title={`tracks ${b.upstream}`}>↑ {b.upstream}</span>
                )}
                {b.lastCommitRel && (
                  <span className="bpk__age">{b.lastCommitRel}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
