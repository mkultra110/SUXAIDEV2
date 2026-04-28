/**
 * Cross-file Monaco markers stream.
 * v2.1 — feeds the Problems panel.
 *
 * Monaco's `editor.onDidChangeMarkers` fires every time ANY model's
 * markers change (TS / JSON / CSS / HTML built-in services publish
 * here). We listen once at app boot and republish a flat
 * `Diagnostic[]` to React via a `useAllDiagnostics()` hook.
 *
 * Why this lives outside `editor-context-tracker.ts` :
 *   - The tracker is scoped to the active file (it ships diagnostics
 *     for the model the user has focused, into `<linter_errors>` of
 *     `<additional_data>`).
 *   - The Problems panel needs EVERY file's diagnostics, including
 *     files in background tabs the user isn't currently looking at.
 *   - Two separate concerns → two separate modules.
 */
import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';

export interface Diagnostic {
  path: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  source?: string;
}

const EVT = 'suxai:all-diagnostics';

/** Module-level cache so listeners that subscribe LATE still see the
 *  current list immediately. Without this, a panel mounting after the
 *  initial markers fired would show empty until the next file change. */
let cached: Diagnostic[] = [];
let started = false;

function severityOf(s: monaco.MarkerSeverity): Diagnostic['severity'] {
  if (s === monaco.MarkerSeverity.Error) return 'error';
  if (s === monaco.MarkerSeverity.Warning) return 'warning';
  if (s === monaco.MarkerSeverity.Info) return 'info';
  return 'hint';
}

function pathOf(uri: monaco.Uri): string {
  if (uri.scheme === 'file') return uri.fsPath;
  // inmemory://... or untitled — use the path component as best-effort.
  return uri.path;
}

function recompute(): void {
  // No resource filter → every model's markers.
  const markers = monaco.editor.getModelMarkers({});
  const next: Diagnostic[] = markers.map((m) => ({
    path: pathOf(m.resource),
    severity: severityOf(m.severity),
    message: m.message,
    line: m.startLineNumber,
    column: m.startColumn,
    endLine: m.endLineNumber,
    endColumn: m.endColumn,
    source: m.source,
  }));
  cached = next;
  window.dispatchEvent(new CustomEvent<Diagnostic[]>(EVT, { detail: next }));
}

/** Boot the global marker subscription. Idempotent — only the first
 *  call wires the Monaco listener. Called once from `App.tsx`. */
export function startAllDiagnosticsStream(): void {
  if (started) return;
  started = true;
  monaco.editor.onDidChangeMarkers(() => recompute());
  // Initial population in case markers exist from boot-time language
  // service runs (TS service flags errors as soon as it parses).
  recompute();
}

export function useAllDiagnostics(): Diagnostic[] {
  const [list, setList] = useState<Diagnostic[]>(cached);
  useEffect(() => {
    setList(cached); // sync any updates that happened between mount and effect
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Diagnostic[]>).detail;
      setList(detail);
    };
    window.addEventListener(EVT, handler);
    return () => window.removeEventListener(EVT, handler);
  }, []);
  return list;
}

/** Aggregate counts by severity. Memoising at the call site is the
 *  caller's responsibility — usually trivial since the array is short. */
export function diagnosticsCounts(d: Diagnostic[]): { error: number; warning: number; info: number; hint: number; total: number } {
  let error = 0;
  let warning = 0;
  let info = 0;
  let hint = 0;
  for (const x of d) {
    if (x.severity === 'error') error++;
    else if (x.severity === 'warning') warning++;
    else if (x.severity === 'info') info++;
    else hint++;
  }
  return { error, warning, info, hint, total: d.length };
}
