import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { emitAiCommand } from '../../lib/commands';
import { useTasks, runTask } from '../../lib/tasks';
import { openGitLog } from '../Sidebar/GitLogModal';
import { stashPush, stashPop, listStashes } from '../../lib/git';
import {
  parseCodeWorkspace,
  serializeCodeWorkspace,
  makeCodeWorkspace,
} from '../../lib/code-workspace';
import { setColorTheme, toggleColorTheme } from '../../lib/theme';
import './CommandPalette.css';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: 'File' | 'Editor' | 'Git' | 'AI' | 'Workspace' | 'Account' | 'Tasks';
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const {
    openFile, saveActiveFile, saveAllDirty, activeFile, workspaceRoot, workspaceRoots,
    workspaceFile,
    setWorkspaceRoot, setWorkspaceRoots, addWorkspaceRoot, removeWorkspaceRoot,
    setWorkspaceFile,
  } = useWorkspace();
  const { logout, user } = useAuth();
  const toast = useToast();
  const tasks = useTasks(workspaceRoot);

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
        id: 'file.save-all',
        label: 'File: Save All',
        hint: 'Ctrl+Alt+S',
        group: 'File',
        run: async () => {
          const { saved, skipped, failed } = await saveAllDirty(undefined, { skipUntitled: true });
          if (failed > 0) toast.error('Save All', `${saved} saved · ${failed} failed`);
          else if (saved > 0) toast.success('Save All', `${saved} fichier${saved > 1 ? 's' : ''}`);
          else if (skipped > 0) toast.info('Save All', 'Rien à sauvegarder.');
          else toast.info('Save All', 'No dirty files');
        },
      },
      {
        id: 'editor.format',
        label: 'Editor: Format Document',
        hint: 'Shift+Alt+F',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:format-document'));
        },
      },
      {
        id: 'editor.indent-spaces',
        label: 'Editor: Convert Indentation to Spaces',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:indent-to-spaces'));
        },
      },
      {
        id: 'editor.indent-tabs',
        label: 'Editor: Convert Indentation to Tabs',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:indent-to-tabs'));
        },
      },
      {
        id: 'editor.go-to-definition',
        label: 'Go to Definition',
        hint: 'F12',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:reveal-definition'));
        },
      },
      {
        id: 'editor.peek-definition',
        label: 'Peek Definition',
        hint: 'Alt+F12',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:peek-definition'));
        },
      },
      {
        id: 'editor.find-references',
        label: 'Find All References',
        hint: 'Shift+F12',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:go-to-references'));
        },
      },
      {
        id: 'editor.rename',
        label: 'Rename Symbol',
        hint: 'F2',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:rename-symbol'));
        },
      },
      {
        id: 'editor.quick-outline',
        label: 'Go to Symbol in File…',
        hint: 'Ctrl+Shift+O',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:quick-outline'));
        },
      },
      {
        id: 'editor.next-problem',
        label: 'Go to Next Problem',
        hint: 'F8',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:next-problem'));
        },
      },
      {
        id: 'editor.prev-problem',
        label: 'Go to Previous Problem',
        hint: 'Shift+F8',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:prev-problem'));
        },
      },
      {
        id: 'editor.quick-fix',
        label: 'Quick Fix…',
        hint: 'Ctrl+.',
        group: 'Editor',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:quick-fix'));
        },
      },
      {
        id: 'editor.replace-in-files',
        label: 'Edit: Replace in Files…',
        hint: 'Ctrl+Shift+H',
        group: 'Editor',
        run: () => {
          // Synthesize Ctrl+Shift+H so the SearchInFiles modal owner
          // (its own keydown handler) opens with replace mode on.
          const isMac =
            typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'H',
              code: 'KeyH',
              ctrlKey: !isMac,
              metaKey: isMac,
              shiftKey: true,
              bubbles: true,
            }),
          );
        },
      },
      {
        id: 'workspace.close',
        label: workspaceRoots.length > 1
          ? 'Workspace: Close all folders'
          : 'Workspace: Close current folder',
        group: 'Workspace',
        run: () => {
          setWorkspaceRoot(null);
          toast.info(workspaceRoots.length > 1 ? 'All folders closed' : 'Workspace closed');
        },
      },
      {
        id: 'workspace.add-folder',
        label: 'Workspace: Add folder…',
        group: 'Workspace',
        run: async () => {
          const root = await window.suxai.fs.openFolder();
          if (!root) return;
          addWorkspaceRoot(root);
          const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
          toast.success('Folder added', name);
        },
      },
      {
        id: 'workspace.save-as',
        label: workspaceFile
          ? 'Workspace: Save Workspace As…'
          : 'Workspace: Save Workspace As… (.code-workspace)',
        group: 'Workspace',
        run: async () => {
          if (workspaceRoots.length === 0) {
            toast.info('Nothing to save', 'Open at least one folder first.');
            return;
          }
          const ws = makeCodeWorkspace(workspaceRoots);
          const content = serializeCodeWorkspace(ws);
          const suggested =
            workspaceRoots[0].split(/[\\/]/).filter(Boolean).pop() ?? 'workspace';
          try {
            const written = await window.suxai.fs.saveWorkspace(content, suggested);
            if (!written) return;
            setWorkspaceFile(written);
            const name = written.split(/[\\/]/).pop() ?? written;
            toast.success('Workspace saved', name);
          } catch (err) {
            toast.error('Save Workspace failed', (err as Error).message);
          }
        },
      },
      {
        id: 'workspace.open-from-file',
        label: 'Workspace: Open Workspace From File…',
        group: 'Workspace',
        run: async () => {
          try {
            const file = await window.suxai.fs.openWorkspace();
            if (!file) return;
            const ws = parseCodeWorkspace(file.content);
            if (!ws) {
              toast.error(
                'Invalid .code-workspace',
                'File could not be parsed as JSONC with a `folders` array.',
              );
              return;
            }
            setWorkspaceRoots(ws.folders.map((f) => f.path));
            setWorkspaceFile(file.path);
            const name = file.path.split(/[\\/]/).pop() ?? file.path;
            const note =
              ws.settings && Object.keys(ws.settings).length > 0
                ? `${ws.folders.length} folders · top-level "settings" not yet honored`
                : `${ws.folders.length} folders`;
            toast.success(`Opened ${name}`, note);
          } catch (err) {
            toast.error('Open Workspace failed', (err as Error).message);
          }
        },
      },
      ...(workspaceRoots.length > 1
        ? workspaceRoots.map((root) => {
            const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
            return {
              id: `workspace.remove-folder:${root}`,
              label: `Workspace: Remove folder « ${name} »`,
              hint: root,
              group: 'Workspace' as const,
              run: () => {
                removeWorkspaceRoot(root);
                toast.info('Folder removed', name);
              },
            };
          })
        : []),
      {
        id: 'view.toggle-output',
        label: 'View: Toggle Output Panel',
        hint: 'Ctrl+Shift+U',
        group: 'Workspace',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:open-output'));
        },
      },
      {
        id: 'view.toggle-zen',
        label: 'View: Toggle Zen Mode',
        hint: 'Ctrl+K Z',
        group: 'Workspace',
        run: () => {
          window.dispatchEvent(new CustomEvent('suxai:toggle-zen-mode'));
        },
      },
      {
        id: 'theme.dark',
        label: 'Preferences: Color Theme — Atelier Dark',
        group: 'Account',
        run: () => {
          setColorTheme('dark');
          toast.info('Theme', 'Atelier Dark activated');
        },
      },
      {
        id: 'theme.light',
        label: 'Preferences: Color Theme — Atelier Light',
        group: 'Account',
        run: () => {
          setColorTheme('light');
          toast.info('Theme', 'Atelier Light activated');
        },
      },
      {
        id: 'theme.toggle',
        label: 'Preferences: Toggle Light/Dark',
        group: 'Account',
        run: () => {
          const next = toggleColorTheme();
          toast.info('Theme', next === 'light' ? 'Atelier Light activated' : 'Atelier Dark activated');
        },
      },
      {
        id: 'git.show-history',
        label: 'Git: Show History…',
        group: 'Git',
        run: () => {
          if (!workspaceRoot) return toast.info('No workspace open');
          openGitLog();
        },
      },
      {
        id: 'git.stash-push',
        label: 'Git: Stash All Changes',
        group: 'Git',
        run: async () => {
          if (!workspaceRoot) return toast.info('No workspace open');
          const err = await stashPush(workspaceRoot, undefined, true);
          if (err) toast.error('Stash failed', err);
          else toast.success('Stashed', 'All changes saved to a new stash.');
        },
      },
      {
        id: 'git.stash-pop',
        label: 'Git: Pop Latest Stash',
        group: 'Git',
        run: async () => {
          if (!workspaceRoot) return toast.info('No workspace open');
          const stashes = await listStashes(workspaceRoot);
          if (stashes.length === 0) {
            toast.info('No stashes', 'Nothing to pop.');
            return;
          }
          const err = await stashPop(workspaceRoot, 0);
          if (err) toast.error('Pop failed', err);
          else toast.success('Stash applied', stashes[0].subject);
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
    // v0.16.12 — append workspace tasks dynamically. Each label-only
    // entry runs the task via terminal:run-once and toasts the
    // captured stdout (truncated). When the workspace doesn't have
    // a .suxai/tasks.json, `tasks` is just an empty array and this
    // loop adds nothing.
    if (workspaceRoot && tasks.length > 0) {
      for (const t of tasks) {
        list.push({
          id: `task:${t.label}`,
          label: `Run task: ${t.label}`,
          hint: t.command.length <= 40 ? t.command : t.command.slice(0, 37) + '…',
          group: 'Tasks',
          run: async () => {
            toast.info('Running task', t.label);
            const res = await runTask(t, workspaceRoot);
            if (!res.ok) {
              toast.error(`Task "${t.label}" failed`, res.error);
              return;
            }
            const out = res.stdout.trim();
            const tail = out.length > 360 ? '…' + out.slice(-340) : out;
            const summary = res.timedOut
              ? 'timed out'
              : `exited ${res.exitCode}`;
            const title = `Task "${t.label}" — ${summary}`;
            if (res.exitCode === 0 && !res.timedOut) {
              toast.success(title, tail || '(no output)');
            } else {
              toast.error(title, tail || '(no output)');
            }
          },
        });
      }
    }
    return list;
  }, [
    openFile, setWorkspaceRoot, setWorkspaceRoots, addWorkspaceRoot, removeWorkspaceRoot,
    setWorkspaceFile, workspaceFile,
    saveActiveFile, saveAllDirty, activeFile, workspaceRoots, logout, user, toast,
    workspaceRoot, tasks,
  ]);

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
