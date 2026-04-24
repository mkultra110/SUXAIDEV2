import { useEffect, useState } from 'react';

export interface Settings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  defaultModelId: string;
}

const KEY = 'suxai.settings.v1';

const DEFAULTS: Settings = {
  fontSize: 13,
  tabSize: 2,
  wordWrap: true,
  minimap: false,
  defaultModelId: 'claude-sonnet-4-6-thinking',
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
