import * as monaco from 'monaco-editor';
import { useEffect, useState } from 'react';

/**
 * v0.16.11 — User snippets manager.
 *
 * VSCode-compatible JSON format keyed by language id (or "*" for
 * global). Each snippet has `prefix`, `body` (string or string[]
 * joined by \n), and optional `description`. Body supports the
 * standard $1 / $2 / ${1:default} placeholders that Monaco's snippet
 * controller resolves natively.
 *
 * Storage : userData/snippets.json. The renderer registers ONE
 * CompletionItemProvider that filters snippets by current language
 * id at completion time, so adding new snippets at runtime is just
 * a matter of refreshing the cache (no need to dispose / re-register).
 */

export interface SnippetDef {
  prefix: string;
  body: string | string[];
  description?: string;
}

/** Outer key = language id ("*" for global), inner key = snippet name. */
export type SnippetMap = Record<string, Record<string, SnippetDef>>;

const REFRESH_EVENT = 'suxai:snippets-refresh';

let cache: SnippetMap = {};
let cacheLoaded = false;
let provider: monaco.IDisposable | null = null;

async function loadFromDisk(): Promise<void> {
  if (!window.suxai?.snippets?.read) {
    cache = {};
    cacheLoaded = true;
    return;
  }
  try {
    const res = await window.suxai.snippets.read();
    if (res.ok) cache = res.snippets ?? {};
    else cache = {};
  } catch {
    cache = {};
  }
  cacheLoaded = true;
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

/** One-time global registration. Idempotent ; subsequent calls no-op. */
export function ensureSnippetProvider(): void {
  if (provider) return;
  if (!cacheLoaded) void loadFromDisk();
  provider = monaco.languages.registerCompletionItemProvider(
    { pattern: '**' },
    {
      provideCompletionItems: (model, position) => {
        const lang = model.getLanguageId();
        const wordInfo = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber, wordInfo.startColumn,
          position.lineNumber, wordInfo.endColumn,
        );
        const candidates: monaco.languages.CompletionItem[] = [];
        const seen = new Set<string>();
        // Language-specific bucket first, then "*" global.
        for (const bucketKey of [lang, '*']) {
          const bucket = cache[bucketKey];
          if (!bucket) continue;
          for (const [name, def] of Object.entries(bucket)) {
            if (typeof def?.prefix !== 'string' || def.prefix.length === 0) continue;
            const dedupKey = `${def.prefix}::${name}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            const body = Array.isArray(def.body) ? def.body.join('\n') : (def.body ?? '');
            candidates.push({
              label: { label: def.prefix, description: name },
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: def.description ?? `snippet (${bucketKey})`,
              documentation: { value: '```' + (lang === bucketKey ? lang : '') + '\n' + body + '\n```' },
              range,
              sortText: '0_' + def.prefix,  // boost above generic completions
            });
          }
        }
        return { suggestions: candidates };
      },
    },
  );
}

/** Force a re-load + broadcast. Called after snippets:save. */
export async function refreshSnippets(): Promise<void> {
  cacheLoaded = false;
  await loadFromDisk();
}

/** Read the current cache for UI display (Settings panel listing). */
export function getSnippetsCache(): SnippetMap {
  return cache;
}

/** Save snippets via IPC and refresh the cache. */
export async function saveSnippets(map: SnippetMap): Promise<string | null> {
  if (!window.suxai?.snippets?.save) return 'snippets IPC unavailable';
  try {
    const res = await window.suxai.snippets.save({ snippets: map });
    if (res.ok) {
      await refreshSnippets();
      return null;
    }
    return res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

/** React hook : returns the live snippets map. Auto-loads on mount,
 *  subscribes to refresh broadcasts. */
export function useSnippets(): SnippetMap {
  const [map, setMap] = useState<SnippetMap>(cache);

  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      if (!cacheLoaded) await loadFromDisk();
      if (!cancelled) setMap({ ...cache });
    };
    void sync();
    const handler = () => { if (!cancelled) setMap({ ...cache }); };
    window.addEventListener(REFRESH_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(REFRESH_EVENT, handler);
    };
  }, []);

  return map;
}
