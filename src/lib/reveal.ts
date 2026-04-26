// Cross-component "jump to line" handoff. SearchInFiles (and any
// future caller — error stack trace navigator, "go to definition")
// stamps a pending reveal here, then EditorPanel consumes it once
// the matching tab becomes active. Module-level state is fine: only
// one reveal can be pending at a time, and it's transient.

let pending: { path: string; line: number; column?: number } | null = null;

export function setPendingReveal(path: string, line: number, column?: number): void {
  pending = { path, line, column };
}

/** Returns the pending line if `path` matches, then clears it. */
export function consumePendingReveal(path: string): { line: number; column?: number } | null {
  if (pending && pending.path === path) {
    const { line, column } = pending;
    pending = null;
    return { line, column };
  }
  return null;
}

export function clearPendingReveal(): void {
  pending = null;
}
