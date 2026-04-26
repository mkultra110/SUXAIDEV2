import * as monaco from 'monaco-editor';
import { API_BASE_URL } from '../config';
import { tryRefreshToken } from '../api/client';

/**
 * Monaco InlineCompletionsProvider that calls /ai/complete on the
 * SUXAI VPS. Powers the Cursor-style "Tab to accept" ghost text.
 *
 * Design choices:
 *   - Debounced 110 ms before fetching: avoids flooding the server
 *     while the user is mid-typing. Anything faster and Haiku
 *     hasn't finished the previous request before the next one starts.
 *   - AbortController per request: each new keystroke cancels the
 *     in-flight one, so we never paint stale ghost text from a
 *     two-keystroke-old completion.
 *   - LRU cache keyed on (prefix-tail, suffix-head, language): same
 *     local context → same suggestion served from RAM, ~0 ms latency
 *     and no quota spend.
 *   - Trigger filter: skip strings/comments-heavy lines and very
 *     short prefixes (< 2 chars on the current line) — Haiku's
 *     suggestions there are usually noise.
 *   - On 429/network failure: silent. Tab autocomplete must NEVER
 *     interrupt the user's typing flow with a popup or toast.
 *
 * Usage: call `registerTabCompletion(monacoNS, getToken)` once after
 * the first editor mounts. Returns a disposer.
 */

interface RegisterArgs {
  /** Resolves the current JWT (lives in the React AuthContext). */
  getToken: () => string | null;
  /** True when the feature is on. Re-evaluated per request. */
  isEnabled: () => boolean;
}

interface CacheEntry {
  text: string;
  ts: number;
}

const CACHE_LIMIT = 100;
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
  const e = cache.get(key);
  if (!e) return null;
  // Refresh LRU position by re-inserting.
  cache.delete(key);
  cache.set(key, e);
  return e.text;
}
function cachePut(key: string, text: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { text, ts: Date.now() });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// v0.12.1 (audit #26): SHA-256 the full string. The previous
// `slice(0,512) + ' ' + slice(-512)` heuristic collided on any
// edit that changed only the middle — caching could then serve a
// now-wrong completion for a different cursor context. SubtleCrypto
// is available in every Electron renderer; the digest cost is
// ~50 µs per ~6 KB string, well below the 110 ms debounce.
const _hashEnc = new TextEncoder();
async function hashKey(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', _hashEnc.encode(s));
  // 8 bytes (16 hex chars) is enough for the local cache namespace —
  // collision chance on a 100-entry LRU is < 1 / 2^58.
  const view = new Uint8Array(buf, 0, 8);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

const PREFIX_LOOKBACK = 4_000;
const SUFFIX_LOOKAHEAD = 2_000;

// v0.12.3 (audit #28): on 429, all in-flight + future autocomplete
// requests back off until `rateLimitedUntil`. The provider returns
// empty during the window so the user keeps typing without
// hammering the server. Cleared once the timestamp passes.
let rateLimitedUntil = 0;

export function registerTabCompletion(args: RegisterArgs): monaco.IDisposable {
  // We register one provider matching ALL languages. Monaco resolves
  // language-specific providers per-language; passing { language: '*' }
  // works on Monaco 0.50+.
  const provider: monaco.languages.InlineCompletionsProvider = {
    async provideInlineCompletions(model, position, _context, token) {
      if (!args.isEnabled()) return { items: [] };
      const auth = args.getToken();
      if (!auth) return { items: [] };

      // Skip near-empty current lines (very short prefix on the
      // line) — Haiku tends to hallucinate without anchor text.
      const lineContent = model.getLineContent(position.lineNumber);
      const beforeCaret = lineContent.slice(0, position.column - 1);
      if (beforeCaret.trim().length < 2) return { items: [] };

      // Build prefix / suffix windows. Bounded to keep latency low.
      const totalLines = model.getLineCount();
      const prefix = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      }).slice(-PREFIX_LOOKBACK);
      const suffix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: totalLines,
        endColumn: model.getLineMaxColumn(totalLines),
      }).slice(0, SUFFIX_LOOKAHEAD);
      const language = model.getLanguageId();

      const cacheKey = `${language}${await hashKey(prefix)}${await hashKey(suffix)}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        return {
          items: [
            {
              insertText: cached,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        };
      }

      // Debounce 110 ms — give the user time to keep typing.
      await new Promise((r) => setTimeout(r, 110));
      if (token.isCancellationRequested) return { items: [] };

      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());

      const doFetch = async (jwt: string): Promise<Response> =>
        fetch(`${API_BASE_URL}/ai/complete`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ prefix, suffix, language, max_tokens: 200 }),
          signal: ac.signal,
        });

      // v0.12.3 (audit #28): respect rate-limit cool-off. Cheaper than
      // letting the request fly and catching the 429 — saves a round-
      // trip per keystroke for ~5 seconds after a burst.
      if (Date.now() < rateLimitedUntil) return { items: [] };
      try {
        let res = await doFetch(auth);
        if (res.status === 401) {
          try { await res.text(); } catch { /* drain */ }
          const fresh = await tryRefreshToken();
          if (fresh) res = await doFetch(fresh);
        }
        if (res.status === 429) {
          // v0.12.3: 5-second cool-off + jitter on 429. Honour
          // Retry-After header if the server set one (server emits
          // it via express-rate-limit standardHeaders:'draft-7').
          const retryAfter = parseInt(res.headers.get('retry-after') ?? '', 10);
          const coolMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 5_000 + Math.floor(Math.random() * 2_000);
          rateLimitedUntil = Date.now() + coolMs;
          try { await res.text(); } catch { /* drain */ }
          return { items: [] };
        }
        if (!res.ok) return { items: [] };
        const obj = (await res.json()) as { completion?: string };
        const completion = (obj.completion ?? '').replace(/\r/g, '');
        if (!completion.trim()) return { items: [] };
        cachePut(cacheKey, completion);
        return {
          items: [
            {
              insertText: completion,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
          // Stable across edits — Monaco keeps the ghost text visible
          // while the user types matching characters.
          enableForwardStability: true,
        };
      } catch {
        // Aborted, network down, or 429. Stay silent.
        return { items: [] };
      }
    },
    freeInlineCompletions() {
      // No allocations to free — items are GC'd naturally.
    },
  };

  return monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    provider,
  );
}
