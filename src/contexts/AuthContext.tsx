import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, authApi, type AuthUser } from '../api/client';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  error: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
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

  const finalizeLogin = useCallback(async (token: string, user: AuthUser) => {
    await window.suxai.auth.setToken(token);
    setState({ user, token, status: 'authenticated', error: null });
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      setState((s) => ({ ...s, error: null }));
      try {
        const res = await authApi.login(email, password);
        await finalizeLogin(res.token, res.user);
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
    async (email: string, password: string) => {
      setState((s) => ({ ...s, error: null }));
      try {
        const res = await authApi.register(email, password);
        await finalizeLogin(res.token, res.user);
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : 'Unable to create account. Please try again.';
        setState((s) => ({ ...s, error: message }));
        throw err;
      }
    },
    [finalizeLogin],
  );

  const logout = useCallback(async () => {
    await window.suxai.auth.clearToken();
    setState({ user: null, token: null, status: 'unauthenticated', error: null });
  }, []);

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
