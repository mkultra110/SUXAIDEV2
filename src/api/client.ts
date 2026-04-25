import { API_BASE_URL } from '../config';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
  /** Internal: set by retry path to avoid infinite loops. */
  _retried?: boolean;
}

/**
 * Hook the AuthContext installs at mount. Called when a request 401s so we
 * can try the refresh-token flow and retry once. If the refresh itself
 * fails, resolve to null — the caller will bubble up the 401 and the
 * AuthContext will log the user out.
 */
/**
 * Token refresh hook. Receives an AbortSignal that flips when the
 * caller's 10-second wall-clock timeout expires. Hooks SHOULD honour
 * the signal — at minimum they must not write a fresh token to
 * persistent storage after `signal.aborted` becomes true, otherwise a
 * slow server can race a newer refresh and overwrite a current token
 * with a stale one.
 */
type TokenRefresher = (signal: AbortSignal) => Promise<string | null>;
let refreshHook: TokenRefresher | null = null;
export function setTokenRefresher(hook: TokenRefresher | null): void {
  refreshHook = hook;
  // A new login wipes the in-flight refresh promise — the new session
  // shouldn't share state with the old one.
  inFlightRefresh = null;
}

// Single-flight: if many requests 401 simultaneously (e.g. an SSE
// stream + a /auth/me call after wake-from-sleep), they all await the
// same in-flight refresh promise. Without this guard, two refreshes
// would race, the loser writes a stale rotation back to safeStorage,
// and the next refresh fails with "invalid refresh token".
let inFlightRefresh: Promise<string | null> | null = null;

const REFRESH_TIMEOUT_MS = 10_000;

/**
 * Get a fresh token via the refresh flow. Returns null if no refresh is
 * possible (no hook installed, or refresh itself failed). Callers that
 * own their own fetch (e.g. SSE streams) use this to retry once on 401.
 *
 * The hook itself is wrapped in a 10s timeout — a hung server must not
 * starve every other 401-retry attempt forever.
 */
export async function tryRefreshToken(): Promise<string | null> {
  if (!refreshHook) return null;
  if (inFlightRefresh) return inFlightRefresh;
  const hook = refreshHook;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);
  inFlightRefresh = (async () => {
    try {
      // Race the hook against the timeout. If the hook hasn't returned
      // by REFRESH_TIMEOUT_MS, ac.abort() flips the signal and the
      // hook should bail before persisting any token. We then resolve
      // null to unblock the caller. The hook itself may continue
      // running for cleanup, but it must not write through stale data.
      const result = await Promise.race<string | null>([
        hook(ac.signal).catch(() => null),
        new Promise<null>((resolve) => {
          ac.signal.addEventListener('abort', () => resolve(null), { once: true });
        }),
      ]);
      return ac.signal.aborted ? null : result;
    } finally {
      clearTimeout(timer);
      // Clear AFTER the promise settles so concurrent awaiters share
      // the same result — don't clear preemptively.
      setTimeout(() => { inFlightRefresh = null; }, 0);
    }
  })();
  return inFlightRefresh;
}

async function rawRequest<T>(pathname: string, opts: RequestOptions): Promise<T> {
  const { body, token, timeoutMs = 15_000, headers, ...rest } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE_URL}${pathname}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    const json = text ? safeParse(text) : null;

    if (!res.ok) {
      const msg = (json && (json.message || json.error)) || `Request failed: ${res.status}`;
      throw new ApiError(msg, res.status, json?.code);
    }
    return json as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ApiError('Request timed out', 0, 'TIMEOUT');
    }
    throw new ApiError((err as Error).message || 'Network error', 0, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

async function request<T = unknown>(pathname: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(pathname, opts);
  } catch (err) {
    // Attempt one refresh + retry when a token-bearing call returns 401.
    if (
      err instanceof ApiError &&
      err.status === 401 &&
      opts.token &&
      refreshHook &&
      !opts._retried &&
      pathname !== '/auth/refresh'
    ) {
      // Single-flight via tryRefreshToken so simultaneous 401s collapse
      // to a single refresh round-trip.
      const fresh = await tryRefreshToken();
      if (fresh) {
        return rawRequest<T>(pathname, { ...opts, token: fresh, _retried: true });
      }
    }
    throw err;
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface AuthUser {
  id: string;
  username: string;
  tier?: 'free' | 'pro';
}

export interface AuthResponse {
  token: string;
  refreshToken?: string;
  user: AuthUser;
}

export interface MeResponse extends AuthUser {
  usedMs: number;
}

export const authApi = {
  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: { username, password } }),

  register: (username: string, password: string) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: { username, password },
    }),

  me: (token: string) => request<MeResponse>('/auth/me', { method: 'GET', token }),

  refresh: (refreshToken: string) =>
    request<AuthResponse>('/auth/refresh', { method: 'POST', body: { refreshToken } }),

  redeemLicense: (token: string, key: string) =>
    request<{ user: AuthUser }>('/auth/redeem-license', {
      method: 'POST',
      token,
      body: { key },
    }),
};

export const api = { request };
