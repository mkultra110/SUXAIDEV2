import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import './LoginScreen.css';

type Mode = 'login' | 'register';

export function LoginScreen() {
  const { login, register, error, clearError } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    if (!email.trim() || !password.trim()) {
      setFieldError('Email and password are required.');
      return;
    }
    if (mode === 'register' && password !== confirm) {
      setFieldError('Passwords do not match.');
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setFieldError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password);
      }
    } catch {
      /* error is surfaced via context */
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    clearError();
    setFieldError(null);
  };

  return (
    <div className="login">
      <div className="login__ambient" aria-hidden />
      <div className="login__card glass-strong">
        <div className="login__brand">
          <div className="login__logo" aria-hidden>
            <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#7d82f8" />
                  <stop offset="100%" stopColor="#5457d8" />
                </linearGradient>
              </defs>
              <rect x="3" y="3" width="26" height="26" rx="8" fill="url(#lg)" />
              <path
                d="M10 20c0-3 2.5-4 5-4 1.6 0 2.8.4 3.7 1l-1.5 2c-.6-.4-1.3-.6-2.1-.6-1.2 0-2 .5-2 1.3 0 .9.7 1.1 2.3 1.5 2.2.5 3.8 1.2 3.8 3.4 0 2.4-2.2 3.8-5.1 3.8-2 0-3.8-.6-5.1-1.7l1.6-2c.9.8 2.1 1.2 3.4 1.2 1.3 0 2-.4 2-1.2 0-.9-.6-1.1-2.4-1.5-2.2-.5-3.6-1.1-3.6-3.2Z"
                fill="#fff"
                opacity="0.9"
              />
            </svg>
          </div>
          <div>
            <div className="login__title">SUXAI</div>
            <div className="login__subtitle">Your AI coding workspace</div>
          </div>
        </div>

        <div className="login__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'login'}
            className={`login__tab ${mode === 'login' ? 'login__tab--active' : ''}`}
            onClick={() => switchMode('login')}
            type="button"
          >
            Sign in
          </button>
          <button
            role="tab"
            aria-selected={mode === 'register'}
            className={`login__tab ${mode === 'register' ? 'login__tab--active' : ''}`}
            onClick={() => switchMode('register')}
            type="button"
          >
            Create account
          </button>
          <span
            className="login__tab-indicator"
            style={{ transform: mode === 'register' ? 'translateX(100%)' : 'translateX(0)' }}
          />
        </div>

        <form className="login__form" onSubmit={onSubmit}>
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={submitting}
            required
          />
          <Input
            label="Password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={submitting}
            required
          />
          {mode === 'register' && (
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              disabled={submitting}
              required
            />
          )}

          {(fieldError || error) && (
            <div className="login__error" role="alert">
              {fieldError || error}
            </div>
          )}

          <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <div className="login__foot">
          Secure login · tokens stored locally encrypted
        </div>
      </div>
    </div>
  );
}
