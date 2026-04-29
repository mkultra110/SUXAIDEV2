/**
 * v3.16 — Color theme switcher.
 *
 * Pilote l'attribut `data-theme` sur `<html>` (que toute la cascade
 * CSS lit pour basculer entre Atelier Dark et le pendant parchment).
 * Le Monaco editor a son propre observer (EditorPanel) qui écoute
 * `suxai:theme-changed` pour appeler `setTheme(suxaiThemeForMode)`.
 *
 * Persistance : `localStorage['suxai.theme.v1']`. Restauration au
 * boot via `bootColorTheme()` (appelé depuis main.tsx).
 */

const STORAGE_KEY = 'suxai.theme.v1';
const EVENT_NAME = 'suxai:theme-changed';

export type ColorMode = 'dark' | 'light';

/** Read the persisted preference, defaulting to dark. */
function loadPersisted(): ColorMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light') return 'light';
    return 'dark';
  } catch {
    return 'dark';
  }
}

/** Apply the mode to the DOM + persist + broadcast. */
export function setColorTheme(mode: ColorMode): void {
  const root = document.documentElement;
  if (mode === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* quota / disabled — silent */
  }
  window.dispatchEvent(new CustomEvent<ColorMode>(EVENT_NAME, { detail: mode }));
}

/** Toggle between dark and light. */
export function toggleColorTheme(): ColorMode {
  const next: ColorMode = currentColorTheme() === 'light' ? 'dark' : 'light';
  setColorTheme(next);
  return next;
}

/** Read the current effective mode from the DOM. */
export function currentColorTheme(): ColorMode {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** Restore the persisted theme on app boot. Idempotent. Call once
 *  from main.tsx before React mounts so the first paint already
 *  has the right colors. */
export function bootColorTheme(): void {
  setColorTheme(loadPersisted());
}

/** Subscribe to theme changes. Returns a cleanup function. */
export function onColorThemeChanged(cb: (mode: ColorMode) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<ColorMode>).detail;
    if (detail === 'dark' || detail === 'light') cb(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
