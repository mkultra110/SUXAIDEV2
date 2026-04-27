import * as monaco from 'monaco-editor';

/**
 * v0.16.9 — Minimal "LSP-like" TypeScript intelligence.
 *
 * We don't spawn a real `typescript-language-server` child process —
 * that pulls in `monaco-languageclient` + `vscode-languageserver-protocol`
 * + a JSON-RPC IPC bridge, ~50 MB of deps for one feature. Instead we
 * lean on Monaco's BUILT-IN TypeScript service (the same one VSCode
 * uses for its in-browser playgrounds) and feed it the contents of
 * every open .ts/.tsx file via `addExtraLib`. Result :
 *
 *   - hover types, symbol info
 *   - cross-file imports (the model resolves `./other-file` against
 *     the extra-libs registry instead of throwing "module not found")
 *   - inline diagnostics (red squiggles on type errors)
 *   - autocomplete from imports / global symbols
 *
 * Limitations vs a full LSP server :
 *   - no node_modules type resolution out of the box (we'd need to
 *     read package.json + walk node_modules — costly)
 *   - no rename refactor, no go-to-def across uncached files
 *   - declarations from the workspace are limited to currently-open
 *     buffers (we don't walk the entire repo)
 *
 * That's a deliberate scope for v0.16.x — gives 80 % of the daily
 * Intellisense value for 5 % of the integration cost. A proper LSP
 * client can land later as a separate version once the foundations
 * are stable.
 */

interface OpenFile {
  path: string;
  content: string;
  language?: string;
}

let configured = false;
const registered = new Map<string, monaco.IDisposable>();

/** Lazy one-time setup of compiler + diagnostic options. */
function configureOnce(): void {
  if (configured) return;
  configured = true;
  const ts = monaco.languages.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    strict: false,
    noImplicitAny: false,
    allowJs: true,
    isolatedModules: true,
    resolveJsonModule: true,
    typeRoots: [],
    lib: ['ESNext', 'DOM', 'DOM.Iterable'],
  });
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
    // Drop a few noisy default diagnostics that are red-squiggle-spam
    // when the user hasn't installed the @types/* packages we don't
    // mirror into the in-memory libs.
    diagnosticCodesToIgnore: [
      2307,  // Cannot find module 'X' or its corresponding type declarations
      7016,  // Could not find a declaration file for module 'X'
      6133,  // 'X' is declared but its value is never read (UI-only ts files)
    ],
  });
  // Same options apply to plain JavaScript files via the JS defaults.
  ts.javascriptDefaults.setCompilerOptions(ts.typescriptDefaults.getCompilerOptions());
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [2307, 7016, 6133, 7044],
  });
}

/** True if the file is one Monaco's TS service should know about. */
function isTsFile(path: string): boolean {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path);
}

/** Encode a path as a Monaco URI string the TS service accepts. */
function pathToUri(path: string): string {
  // Forward-slash + file:// scheme — Monaco's TS service uses URIs
  // internally, and addExtraLib's filePath argument is a string URI
  // when in-memory model resolution is enabled. We use a synthetic
  // "inmemory://" scheme (Monaco recognises it) keyed on the absolute
  // path so two files in different folders never collide.
  return `inmemory://workspace/${path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/**
 * Register every open .ts/.tsx/.js/.jsx file with Monaco's TS
 * service so cross-file imports + type errors light up. Idempotent :
 * call it whenever the open-files list changes (we dispose stale
 * extra-libs on each call).
 */
export function syncTypeScriptExtraLibs(openFiles: OpenFile[]): void {
  configureOnce();
  const ts = monaco.languages.typescript;
  const wanted = new Set<string>();

  for (const f of openFiles) {
    if (!isTsFile(f.path)) continue;
    if (f.path.startsWith('untitled://')) continue;  // not a resolvable module
    if (f.path.startsWith('history://')) continue;   // synthetic snapshot tabs
    if (f.content.length > 1_500_000) continue;       // skip huge files (1.5 MB)
    wanted.add(f.path);
    const uri = pathToUri(f.path);
    // Dispose the previous registration for this path so the content
    // change is picked up — addExtraLib is idempotent on URI but
    // doesn't auto-update content otherwise.
    registered.get(f.path)?.dispose();
    const disposer = ts.typescriptDefaults.addExtraLib(f.content, uri);
    registered.set(f.path, disposer);
    // Mirror to JS defaults too — JSX/JS imports from a .tsx file
    // need the same resolution table.
    ts.javascriptDefaults.addExtraLib(f.content, uri);
  }

  // Drop registrations for files no longer open.
  for (const [path, disposer] of registered.entries()) {
    if (!wanted.has(path)) {
      try { disposer.dispose(); } catch { /* */ }
      registered.delete(path);
    }
  }
}

/** Tear-down for tests / logout. */
export function disposeAllTsExtraLibs(): void {
  for (const d of registered.values()) {
    try { d.dispose(); } catch { /* */ }
  }
  registered.clear();
}
