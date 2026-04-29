// v2.2 — `.vscode/settings.json` per-project loader (Lot B6).
//
// VSCode parity: the user can drop a `.vscode/settings.json` at the
// workspace root and have it override user-level preferences for the
// time the workspace is open. Implementation is read-only here — we
// don't write back to the file. The user keeps editing via Settings
// dialog (which writes to localStorage user-level) and the workspace
// overrides take precedence at runtime.
//
// `.vscode/settings.json` is JSONC (JSON with comments + trailing
// commas), which `JSON.parse` cannot handle. We strip both inline
// before parsing — the stripper handles quoted strings correctly so
// `"//"` inside a value is not mistaken for a comment.

import type { Settings } from './settings';
import { setWorkspaceOverrides, clearWorkspaceOverrides } from './settings';

const FILE_REL = '.vscode/settings.json';

function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  const norm = sep === '\\' ? rel.replace(/\//g, '\\') : rel;
  return `${trimmed}${sep}${norm}`;
}

/** Strip JSONC line/block comments. Quoted strings are preserved. */
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
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i++;
        continue;
      }
      if (ch === stringQuote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Strip trailing commas before `}` or `]`. JSONC allows them. */
function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse JSONC text. Returns null on malformed input. */
function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch {
    return null;
  }
}

/**
 * Map known VSCode setting keys to our Settings shape. Unknown keys
 * are silently ignored — many `.vscode/settings.json` carry
 * extension-specific config we don't care about.
 */
function mapVscodeKeys(raw: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const get = (k: string) => raw[k];

  const fontSize = get('editor.fontSize');
  if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
    out.fontSize = Math.max(8, Math.min(48, Math.round(fontSize)));
  }

  const tabSize = get('editor.tabSize');
  if (typeof tabSize === 'number' && Number.isFinite(tabSize)) {
    out.tabSize = Math.max(1, Math.min(16, Math.round(tabSize)));
  }

  const wordWrap = get('editor.wordWrap');
  if (typeof wordWrap === 'string') {
    out.wordWrap = wordWrap !== 'off';
  } else if (typeof wordWrap === 'boolean') {
    out.wordWrap = wordWrap;
  }

  const minimap = get('editor.minimap.enabled');
  if (typeof minimap === 'boolean') out.minimap = minimap;

  const fmt = get('editor.formatOnSave');
  if (typeof fmt === 'boolean') out.formatOnSave = fmt;

  const trim = get('files.trimTrailingWhitespace');
  if (typeof trim === 'boolean') out.trimTrailingWhitespaceOnSave = trim;

  const autoSave = get('files.autoSave');
  if (typeof autoSave === 'string') {
    out.autosave = autoSave !== 'off';
  } else if (typeof autoSave === 'boolean') {
    out.autosave = autoSave;
  }

  const autoSaveDelay = get('files.autoSaveDelay');
  if (typeof autoSaveDelay === 'number' && Number.isFinite(autoSaveDelay)) {
    out.autosaveDelayMs = Math.max(200, Math.min(60_000, Math.round(autoSaveDelay)));
  }

  // VSCode's setting is `gitlens.currentLine.enabled` (an extension);
  // for SUXAI we honour `git.blame.enabled` as our own convention.
  const blame = get('git.blame.enabled');
  if (typeof blame === 'boolean') out.gitBlame = blame;

  return out;
}

async function readOneRoot(root: string): Promise<Partial<Settings>> {
  const path = joinPath(root, FILE_REL);
  let text: string;
  try {
    const res = await window.suxai.fs.readFile(path);
    text = res.content;
  } catch {
    return {};
  }
  const parsed = parseJsonc(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[workspace-settings] Could not parse ${path} as JSONC.`);
    return {};
  }
  return mapVscodeKeys(parsed as Record<string, unknown>);
}

/**
 * Read and apply `.vscode/settings.json` from each workspace root,
 * merging in declaration order. Later roots override earlier ones —
 * mirrors VSCode's multi-root precedence (the « primary » root is
 * read first, secondary roots layer on top).
 *
 * v3.13 — accepte aussi un `workspaceFile` optionnel : un chemin de
 * `.code-workspace` dont le block top-level `settings` est lu et
 * mergé EN DERNIER (priorité maximale parité VSCode : workspace
 * file beats per-root .vscode/settings.json).
 *
 * - All roots missing the file → clears overrides (silent).
 * - Parse error on one → that root's settings are skipped + console
 *   warn ; the others still merge.
 *
 * Accepts a single root string for back-compat ; v3.9+ callers pass
 * the full `workspaceRoots` array.
 */
export async function applyWorkspaceSettings(
  rootOrRoots: string | string[] | null,
  workspaceFile?: string | null,
): Promise<void> {
  const roots: string[] = (() => {
    if (rootOrRoots === null) return [];
    if (typeof rootOrRoots === 'string') return rootOrRoots ? [rootOrRoots] : [];
    return rootOrRoots.filter((r) => typeof r === 'string' && r.length > 0);
  })();
  if (roots.length === 0 && !workspaceFile) {
    clearWorkspaceOverrides();
    return;
  }
  let merged: Partial<Settings> = {};
  for (const root of roots) {
    const fragment = await readOneRoot(root);
    merged = { ...merged, ...fragment };
  }
  if (workspaceFile) {
    try {
      const res = await window.suxai.fs.readFile(workspaceFile);
      // .code-workspace est JSONC ; le parsing se fait via le helper
      // strippeur local (mêmes mécaniques que readOneRoot).
      const text = res.content;
      // Lazy import : éviter dépendance circulaire avec code-workspace.ts
      // qui pourrait à terme vouloir consommer workspace-settings.
      const { parseCodeWorkspace } = await import('./code-workspace');
      const ws = parseCodeWorkspace(text);
      if (ws?.settings && typeof ws.settings === 'object') {
        merged = { ...merged, ...mapVscodeKeys(ws.settings as Record<string, unknown>) };
      }
    } catch (err) {
      console.warn(`[workspace-settings] Could not read workspaceFile ${workspaceFile}:`, err);
    }
  }
  setWorkspaceOverrides(merged);
}
