/**
 * v3.6 — Output panel module (parité VSCode A7).
 *
 * Buffer event-streamé de logs nommés par source. N'importe quel
 * composant ou helper peut écrire via `appendOutput(source, line)` ;
 * le `<OutputPanel />` consomme via `useOutput(source)` pour rendre
 * la source active. Les sources connues émergent dynamiquement
 * (premier appel à `appendOutput` enregistre la source).
 *
 * Caps :
 *   - 5000 lignes max par source (oldest dropped on overflow)
 *   - 50 KB par ligne max (truncated avec « …truncated »)
 *
 * Pas de persistance disk : les buffers vivent en mémoire, perdus
 * au refresh. Pour un journal durable, utiliser le main-process
 * file logger (server.log côté VPS, electron logs côté client).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

const MAX_LINES_PER_SOURCE = 5000;
const MAX_LINE_BYTES = 50_000;

export interface OutputLine {
  /** Wall-clock timestamp ms epoch. */
  ts: number;
  /** 'stdout' | 'stderr' | 'info' | 'warn' | 'error'. Drives row tinting. */
  level: 'stdout' | 'stderr' | 'info' | 'warn' | 'error';
  /** Raw line content. Already stripped of trailing newline. */
  text: string;
}

const buffers = new Map<string, OutputLine[]>();
const sourceListeners = new Set<() => void>();
const bufferListeners = new Map<string, Set<() => void>>();

function notifySources(): void {
  for (const fn of sourceListeners) fn();
}

function notifyBuffer(source: string): void {
  const set = bufferListeners.get(source);
  if (!set) return;
  for (const fn of set) fn();
}

/** Truncate a line that exceeds MAX_LINE_BYTES — protects against
 *  rogue tool calls that emit a 10 MB JSON blob in one line. */
function clipLine(text: string): string {
  if (text.length <= MAX_LINE_BYTES) return text;
  return text.slice(0, MAX_LINE_BYTES - 14) + '…truncated';
}

/** Append a line (or multi-line block) to the named source. New
 *  sources auto-register on first write — `<OutputPanel />` will
 *  pick them up via `useOutputSources`. */
export function appendOutput(
  source: string,
  text: string,
  level: OutputLine['level'] = 'stdout',
): void {
  if (!source) return;
  const isNew = !buffers.has(source);
  const buf = buffers.get(source) ?? [];
  // Split on newlines so multi-line blocks render as separate rows
  // (auto-scroll math + line-level severity tinting both rely on it).
  const lines = text.split('\n');
  // Drop a trailing empty line if the input ended with `\n`.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const ts = Date.now();
  for (const ln of lines) {
    buf.push({ ts, level, text: clipLine(ln) });
  }
  if (buf.length > MAX_LINES_PER_SOURCE) {
    buf.splice(0, buf.length - MAX_LINES_PER_SOURCE);
  }
  buffers.set(source, buf);
  if (isNew) notifySources();
  notifyBuffer(source);
}

/** Wipe the buffer for one source. The source itself remains
 *  registered (still selectable in the OutputPanel dropdown). */
export function clearOutput(source: string): void {
  if (!buffers.has(source)) return;
  buffers.set(source, []);
  notifyBuffer(source);
}

/** Drop a source entirely (from dropdown + buffer). Useful when a
 *  task/agent run completes and you want to free its slot. */
export function dropOutputSource(source: string): void {
  if (!buffers.has(source)) return;
  buffers.delete(source);
  notifySources();
}

/** React hook : list of registered source names, sorted alphabetically.
 *  Re-renders when a new source appears or one is dropped. */
export function useOutputSources(): string[] {
  const subscribe = (cb: () => void) => {
    sourceListeners.add(cb);
    return () => sourceListeners.delete(cb);
  };
  const getSnapshot = (): string => Array.from(buffers.keys()).sort().join('\n');
  const flat = useSyncExternalStore(subscribe, getSnapshot, () => '');
  return flat ? flat.split('\n') : [];
}

/** React hook : the current buffer for a source. Re-renders when
 *  new lines append or the buffer is cleared. */
export function useOutput(source: string | null): OutputLine[] {
  const [lines, setLines] = useState<OutputLine[]>(
    () => (source ? buffers.get(source) ?? [] : []),
  );
  useEffect(() => {
    if (!source) {
      setLines([]);
      return;
    }
    setLines(buffers.get(source) ?? []);
    const cb = () => setLines(buffers.get(source) ?? []);
    let set = bufferListeners.get(source);
    if (!set) {
      set = new Set();
      bufferListeners.set(source, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }, [source]);
  return lines;
}
