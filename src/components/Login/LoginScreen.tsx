import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { SuxaiLogo } from '../ui/SuxaiLogo';
import './LoginScreen.css';

type Mode = 'login' | 'register';

const USERNAME_RE = /^[a-zA-Z0-9_-]+$/;

export function LoginScreen() {
  const { login, register, error, clearError } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFieldError(null);
    const u = username.trim();
    if (!u || !password.trim()) {
      setFieldError('Username and password are required.');
      return;
    }
    if (!USERNAME_RE.test(u)) {
      setFieldError('Username can only contain letters, digits, underscore and dash.');
      return;
    }
    if (u.length < 3) {
      setFieldError('Username must be at least 3 characters.');
      return;
    }
    if (mode === 'register') {
      if (password !== confirm) {
        setFieldError('Passwords do not match.');
        return;
      }
      if (password.length < 8) {
        setFieldError('Password must be at least 8 characters.');
        return;
      }
    }
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login(u, password);
      } else {
        await register(u, password);
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
            <SuxaiLogo size={52} glow />
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
            label="Username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="pseudonyme"
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
