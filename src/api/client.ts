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
type TokenRefresher = () => Promise<string | null>;
let refreshHook: TokenRefresher | null = null;
export function setTokenRefresher(hook: TokenRefresher | null): void {
  refreshHook = hook;
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
      const fresh = await refreshHook();
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
  email: string;
  username?: string;
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
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } }),

  register: (email: string, password: string, username?: string) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: username ? { email, password, username } : { email, password },
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
