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
};

function load(): Settings {
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

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [state, setState] = useState<Settings>(load);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Settings>).detail;
      setState((s) => ({ ...s, ...detail }));
    };
    window.addEventListener('suxai:settings', handler);
    return () => window.removeEventListener('suxai:settings', handler);
  }, []);

  const update = (patch: Partial<Settings>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  };

  return [state, update];
}

export const settingsDefaults = DEFAULTS;
