import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, authApi, setTokenRefresher, type AuthUser } from '../api/client';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  error: string | null;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    status: 'loading',
    error: null,
  });

  // The refresher hook is rebuilt every render; keep a stable ref so the
  // ApiClient can always call the latest version.
  const tokenRef = useRef<string | null>(null);
  useEffect(() => {
    tokenRef.current = state.token;
  }, [state.token]);

  // v0.11.13: warn the user once if their tokens are stored in
  // plaintext (Linux without keychain). Defensive checks so a
  // missing IPC (older preload) just no-ops.
  useEffect(() => {
    const backendFn = (window as unknown as {
      suxai?: { auth?: { storageBackend?: () => Promise<string> } };
    }).suxai?.auth?.storageBackend;
    if (typeof backendFn !== 'function') return;
    let cancelled = false;
    void (async () => {
      try {
        const backend = await backendFn();
        if (cancelled) return;
        if (backend === 'basic_text') {
          // Use a console warn so the user sees this in DevTools, AND
          // localStorage flag so we can throttle a real toast to once
          // per session if a Toast hook is available. The toast call
          // is deferred so AuthProvider doesn't depend on the Toast
          // provider mounting first.
          console.warn(
            '[suxai] Refresh tokens are stored in PLAINTEXT (no system keychain detected). ' +
              'Install gnome-keyring (GNOME) or kwalletd (KDE) for encrypted storage.',
          );
          try {
            const seenKey = 'suxai.basicTextWarningSeen';
            if (!localStorage.getItem(seenKey)) {
              localStorage.setItem(seenKey, '1');
              window.dispatchEvent(
                new CustomEvent('suxai:storage-warning', {
                  detail: {
                    title: 'Tokens stored in plaintext',
                    body:
                      'No keychain (gnome-keyring/kwallet) detected. ' +
                      'Session tokens are stored on disk without encryption.',
                  },
                }),
              );
            }
          } catch { /* localStorage off → just keep the console warn */ }
        }
      } catch { /* */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Bootstrap — read token from secure Electron storage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await window.suxai.auth.getToken();
        if (!token) {
          if (!cancelled) setState((s) => ({ ...s, status: 'unauthenticated' }));
          return;
        }
        try {
          const user = await authApi.me(token);
          if (!cancelled) setState({ user, token, status: 'authenticated', error: null });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            await window.suxai.auth.clearToken();
            await window.suxai.auth.clearRefreshToken();
          }
          if (!cancelled) setState({ user: null, token: null, status: 'unauthenticated', error: null });
        }
      } catch {
        if (!cancelled) setState((s) => ({ ...s, status: 'unauthenticated' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const finalizeLogin = useCallback(
    async (token: string, refreshToken: string | undefined, user: AuthUser) => {
      await window.suxai.auth.setToken(token);
      if (refreshToken) {
        await window.suxai.auth.setRefreshToken(refreshToken);
      }
      setState({ user, token, status: 'authenticated', error: null });
    },
    [],
  );

  const logout = useCallback(async () => {
    await window.suxai.auth.clearToken();
    await window.suxai.auth.clearRefreshToken();
    setState({ user: null, token: null, status: 'unauthenticated', error: null });
  }, []);

  // Install the refresh hook so api/client can retry 401s automatically.
  useEffect(() => {
    setTokenRefresher(async (signal) => {
      try {
        const refreshToken = await window.suxai.auth.getRefreshToken();
        if (!refreshToken) return null;
        if (signal.aborted) return null;
        const res = await authApi.refresh(refreshToken);
        // After the network round-trip, the timeout may have fired —
        // bail before writing through to safeStorage so we don't
        // overwrite a newer token written by a concurrent refresh.
        if (signal.aborted) return null;
        await window.suxai.auth.setToken(res.token);
        if (res.refreshToken) {
          await window.suxai.auth.setRefreshToken(res.refreshToken);
        }
        setState((s) => ({ ...s, token: res.token, user: res.user }));
        return res.token;
      } catch {
        // Refresh failed — force logout so the user re-authenticates.
        await logout();
        return null;
      }
    });
    return () => setTokenRefresher(null);
  }, [logout]);

  const login = useCallback(
    async (username: string, password: string) => {
      setState((s) => ({ ...s, error: null }));
      try {
        const res = await authApi.login(username, password);
        await finalizeLogin(res.token, res.refreshToken, res.user);
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : 'Unable to sign in. Please try again.';
        setState((s) => ({ ...s, error: message }));
        throw err;
      }
    },
    [finalizeLogin],
  );

  const register = useCallback(
    async (username: string, password: string) => {
      setState((s) => ({ ...s, error: null }));
      try {
        const res = await authApi.register(username, password);
        await finalizeLogin(res.token, res.refreshToken, res.user);
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : 'Unable to create account. Please try again.';
        setState((s) => ({ ...s, error: message }));
        throw err;
      }
    },
    [finalizeLogin],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, register, logout, clearError }),
    [state, login, register, logout, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
