/**
 * v0.16.8 — Compare two files side-by-side via Monaco DiffEditor.
 *
 * UX flow (matches VSCode "Compare Active File With…" pattern) :
 *   1. Right-click a file in the sidebar → "Select for compare"
 *   2. Right-click a different file → "Compare with selected"
 *   3. Monaco DiffEditor opens in a fullscreen modal
 *
 * Module-level state because the "selected" reference is global —
 * survives across context-menu instances and component re-renders
 * but lives only for the session (no persistence on purpose, the
 * selection is a transient UI affordance).
 */

const SELECTED_KEY = 'suxai.compare.selected';
const COMPARE_EVENT = 'suxai:compare-open';
const SELECTED_CHANGED_EVENT = 'suxai:compare-selected-changed';

export interface CompareEventDetail {
  /** Original / "before" path. */
  a: string;
  /** Modified / "after" path. */
  b: string;
}

let selectedPath: string | null = null;

// Re-hydrate from sessionStorage so a renderer reload (Cmd+R) doesn't
// silently drop the user's pending selection.
try {
  selectedPath = sessionStorage.getItem(SELECTED_KEY);
} catch { /* sessionStorage may be disabled */ }

export function setSelectedForCompare(path: string): void {
  selectedPath = path;
  try { sessionStorage.setItem(SELECTED_KEY, path); } catch { /* */ }
  window.dispatchEvent(new CustomEvent(SELECTED_CHANGED_EVENT, { detail: path }));
}

export function clearSelectedForCompare(): void {
  selectedPath = null;
  try { sessionStorage.removeItem(SELECTED_KEY); } catch { /* */ }
  window.dispatchEvent(new CustomEvent(SELECTED_CHANGED_EVENT, { detail: null }));
}

export function getSelectedForCompare(): string | null {
  return selectedPath;
}

/** Open the compare dialog with `a` (original) vs `b` (modified). */
export function openCompare(a: string, b: string): void {
  window.dispatchEvent(
    new CustomEvent<CompareEventDetail>(COMPARE_EVENT, { detail: { a, b } }),
  );
}

/** Subscribe to compare-open events. Returns an unsubscriber. */
export function onCompareOpen(handler: (detail: CompareEventDetail) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<CompareEventDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(COMPARE_EVENT, listener);
  return () => window.removeEventListener(COMPARE_EVENT, listener);
}

/** Subscribe to selection changes (for menu enable/disable toggles).
 *  Fires with the new selected path or null. */
export function onSelectedChanged(handler: (path: string | null) => void): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<string | null>).detail);
  };
  window.addEventListener(SELECTED_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SELECTED_CHANGED_EVENT, listener);
}
