import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { emitAiCommand } from '../../lib/commands';
import './CommandPalette.css';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: 'File' | 'AI' | 'Workspace' | 'Account';
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { openFile, setWorkspaceRoot, saveActiveFile, activeFile } = useWorkspace();
  const { logout, user } = useAuth();
  const toast = useToast();

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setCursor(0);
  }, []);

  // Ctrl/Cmd+Shift+P toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape' && open) close();
    };
    // v0.15.11 (audit-5 #1) — capture phase to match every other
    // hotkey listener in the app. Bubble phase let Monaco grab
    // Cmd+Shift+P first when the editor was focused.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, close]);

  // Focus input when opened.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'file.open',
        label: 'File: Open file…',
        hint: 'Ctrl+O',
        group: 'File',
        run: async () => {
          const f = await window.suxai.fs.openFile();
          if (!f) return;
          const name = f.path.split(/[\\/]/).pop() ?? f.path;
          openFile({ path: f.path, name, content: f.content });
        },
      },
      {
        id: 'file.open-folder',
        label: 'File: Open folder…',
        group: 'File',
        run: async () => {
          const root = await window.suxai.fs.openFolder();
          if (root) setWorkspaceRoot(root);
        },
      },
      {
        id: 'file.save',
        label: 'File: Save',
        hint: 'Ctrl+S',
        group: 'File',
        run: async () => {
          if (!activeFile) return toast.info('No file open');
          const outcome = await saveActiveFile();
          if (outcome === 'saved') toast.success('Saved', activeFile.name);
          else if (outcome === 'error') toast.error('Save failed', activeFile.name);
        },
      },
      {
        id: 'workspace.close',
        label: 'Workspace: Close current folder',
        group: 'Workspace',
        run: () => {
          setWorkspaceRoot(null);
          toast.info('Workspace closed');
        },
      },
      {
        id: 'ai.explain',
        label: 'AI: Explain selection / active file',
        group: 'AI',
        run: () => emitAiCommand({ command: 'explain' }),
      },
      {
        id: 'ai.refactor',
        label: 'AI: Refactor selection / active file',
        group: 'AI',
        run: () => emitAiCommand({ command: 'refactor' }),
      },
      {
        id: 'ai.fix',
        label: 'AI: Fix bugs',
        group: 'AI',
        run: () => emitAiCommand({ command: 'fix' }),
      },
      {
        id: 'ai.optimize',
        label: 'AI: Optimize',
        group: 'AI',
        run: () => emitAiCommand({ command: 'optimize' }),
      },
      {
        id: 'app.settings',
        label: 'Preferences: Open settings',
        hint: 'Ctrl+,',
        group: 'Account',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:open-settings'));
        },
      },
      {
        id: 'account.logout',
        label: `Account: Sign out${user ? ` (${user.username})` : ''}`,
        group: 'Account',
        run: async () => {
          await logout();
          toast.info('Signed out');
        },
      },
    ];
    return list;
  }, [openFile, setWorkspaceRoot, saveActiveFile, activeFile, logout, user, toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    // Subsequence fuzzy match + score by earliness.
    return commands
      .map((c) => {
        const label = c.label.toLowerCase();
        let qi = 0;
        let score = 0;
        let lastMatchIdx = -1;
        for (let i = 0; i < label.length && qi < q.length; i++) {
          if (label[i] === q[qi]) {
            score += 10 - (i - (lastMatchIdx + 1));
            lastMatchIdx = i;
            qi++;
          }
        }
        return qi === q.length ? { cmd: c, score } : null;
      })
      .filter((x): x is { cmd: Command; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.cmd);
  }, [commands, query]);

  // Reset cursor when results change.
  useEffect(() => {
    setCursor(0);
  }, [query]);

  const runAt = useCallback(
    (i: number) => {
      const cmd = filtered[i];
      if (!cmd) return;
      close();
      // defer so the palette unmounts before the command kicks in — avoids
      // double keystrokes leaking into the next focused element.
      setTimeout(() => void cmd.run(), 0);
    },
    [filtered, close],
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
      runAt(cursor);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="cmdp__overlay" role="dialog" aria-modal="true" onClick={close}>
      <div className="cmdp glass-strong" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdp__input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="cmdp__list">
          {filtered.length === 0 ? (
            <div className="cmdp__empty">No matching command</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`cmdp__item ${i === cursor ? 'cmdp__item--active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => runAt(i)}
              >
                <span className="cmdp__group">{c.group}</span>
                <span className="cmdp__label">{c.label}</span>
                {c.hint && <span className="cmdp__hint">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
        <div className="cmdp__foot">
          <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close
        </div>
      </div>
    </div>,
    document.body,
  );
}
