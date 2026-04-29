/**
 * v3.12 — `.code-workspace` file format (parité VSCode).
 *
 * Forme JSON :
 *   {
 *     "folders": [
 *       { "path": "/abs/folder1" },
 *       { "name": "Custom Display", "path": "/abs/folder2" }
 *     ],
 *     "settings": { "editor.fontSize": 14 }
 *   }
 *
 * VSCode tolère JSONC (commentaires + trailing commas) — on
 * réutilise le stripper de `lib/workspace-settings.ts` via une
 * mini-impl locale pour éviter une dépendance circulaire.
 *
 * Pour V3.12 le `settings` block est lu mais NON appliqué — on
 * laisse le mécanisme `.vscode/settings.json` per-root gérer ça,
 * et on documente le top-level settings comme « not yet honored »
 * dans le toast de import.
 */

export interface CodeWorkspaceFolder {
  path: string;
  name?: string;
}

export interface CodeWorkspace {
  folders: CodeWorkspaceFolder[];
  settings?: Record<string, unknown>;
}

/** Strip JSONC line/block comments. Quoted strings are preserved.
 *  Vendored mini-version of the parser in workspace-settings.ts. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let stringQuote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) { out += next; i++; continue; }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; stringQuote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

export function parseCodeWorkspace(text: string): CodeWorkspace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const rawFolders = obj.folders;
  if (!Array.isArray(rawFolders)) return null;
  const folders: CodeWorkspaceFolder[] = [];
  for (const entry of rawFolders) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== 'string' || e.path.length === 0) continue;
    const folder: CodeWorkspaceFolder = { path: e.path };
    if (typeof e.name === 'string') folder.name = e.name;
    folders.push(folder);
  }
  if (folders.length === 0) return null;
  const out: CodeWorkspace = { folders };
  if (obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings)) {
    out.settings = obj.settings as Record<string, unknown>;
  }
  return out;
}

/** Pretty-print a CodeWorkspace as JSON 2-spaces. The serialized
 *  output is parseable by VSCode and any other JSONC reader. */
export function serializeCodeWorkspace(ws: CodeWorkspace): string {
  // Stable key order for readability + reproducible diffs.
  const out: Record<string, unknown> = {
    folders: ws.folders.map((f) => (f.name ? { name: f.name, path: f.path } : { path: f.path })),
  };
  if (ws.settings && Object.keys(ws.settings).length > 0) {
    out.settings = ws.settings;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/** Build a CodeWorkspace from the current workspace state. */
export function makeCodeWorkspace(roots: string[]): CodeWorkspace {
  return {
    folders: roots.map((p) => ({ path: p })),
  };
}
