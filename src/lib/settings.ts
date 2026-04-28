import { useEffect, useState } from 'react';

export interface Settings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  defaultModelId: string;
  /** Tab autocomplete (Cursor-style ghost text via Haiku 4.5).
   *  Disable if you don't want every keystroke to round-trip the
   *  VPS — saves quota on free tier. */
  tabCompletion: boolean;
  /** v0.13.0 — agent approval mode. Mirrors Cursor's three-level
   *  policy:
   *    'auto'  (default) — file edits open the inline diff and the
   *                        user accepts/rejects per hunk; shell
   *                        commands prompt unless the model asked
   *                        with `require_user_approval=false` AND
   *                        the command matches a safe allowlist.
   *    'step'            — every tool call (read OR write) blocks
   *                        on an approval modal. Paranoid mode for
   *                        debugging suspicious agent behaviour.
   *    'yolo'            — auto-approve everything except commands
   *                        that match DANGER_PATTERNS. The diff
   *                        still appears in the inline diff so the
   *                        user can still reject after-the-fact. */
  approvalMode: 'auto' | 'step' | 'yolo';
  /** v2.1 — VSCode-parity. When enabled, the editor saves the active
   *  file `autosaveDelayMs` after the last keystroke. Save All never
   *  fires automatically — the user keeps control over commits. */
  autosave: boolean;
  autosaveDelayMs: number;
  /** v2.1 — run Monaco's `editor.action.formatDocument` before
   *  writing to disk. Honours each language's registered formatter
   *  (TS/JS/JSON/HTML/CSS ship one out of the box). Skipped silently
   *  if no formatter is registered for the active language. */
  formatOnSave: boolean;
  /** v2.1 — strip trailing spaces on every line before save.
   *  Keeps trailing newline at EOF intact. */
  trimTrailingWhitespaceOnSave: boolean;
}

const KEY = 'suxai.settings.v1';

const DEFAULTS: Settings = {
  fontSize: 13,
  tabSize: 2,
  wordWrap: true,
  minimap: false,
  defaultModelId: 'claude-sonnet-4-6-thinking',
  tabCompletion: true,
  approvalMode: 'auto',
  autosave: false,
  autosaveDelayMs: 1000,
  formatOnSave: false,
  trimTrailingWhitespaceOnSave: false,
};

function loadUser(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function save(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent<Settings>('suxai:settings', { detail: s }));
  } catch {
    /* ignore */
  }
}

// v2.2 — workspace-settings layer. Loaded from `<root>/.vscode/settings.json`
// when a folder opens, cleared on folder close. Effective settings =
// user-level (localStorage) + workspace overrides on top. The dialog
// only writes to user-level — workspace overrides are read-only here
// and are owned by the file in the user's repo.
let workspaceOverrides: Partial<Settings> = {};

export function setWorkspaceOverrides(overrides: Partial<Settings>): void {
  workspaceOverrides = { ...overrides };
  window.dispatchEvent(new CustomEvent('suxai:workspace-settings'));
}

export function clearWorkspaceOverrides(): void {
  if (Object.keys(workspaceOverrides).length === 0) return;
  workspaceOverrides = {};
  window.dispatchEvent(new CustomEvent('suxai:workspace-settings'));
}

export function getWorkspaceOverrides(): Partial<Settings> {
  return { ...workspaceOverrides };
}

function effective(): Settings {
  return { ...loadUser(), ...workspaceOverrides };
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [state, setState] = useState<Settings>(effective);

  useEffect(() => {
    const refresh = () => setState(effective());
    window.addEventListener('suxai:settings', refresh);
    window.addEventListener('suxai:workspace-settings', refresh);
    return () => {
      window.removeEventListener('suxai:settings', refresh);
      window.removeEventListener('suxai:workspace-settings', refresh);
    };
  }, []);

  const update = (patch: Partial<Settings>) => {
    // Patch goes to user-level only. Workspace overrides remain
    // separate so they cannot accidentally leak into the user's
    // localStorage when the workspace is closed.
    const userBase = loadUser();
    const next = { ...userBase, ...patch };
    save(next);
    setState({ ...next, ...workspaceOverrides });
  };

  return [state, update];
}

export const settingsDefaults = DEFAULTS;
