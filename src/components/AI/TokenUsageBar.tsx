import { useEffect, useState } from 'react';
import { authApi } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import './TokenUsageBar.css';

/**
 * Token / streaming usage indicator pinned in the composer footer.
 * Polls /auth/me every 30s while authenticated so the user sees
 * their daily streaming budget tick down in near real-time.
 *
 * Free tier shows a progress bar that fills from green → amber →
 * red as the user approaches the cap. Pro tier (limitMs === 0)
 * shows a discreet "∞" pill instead. While the request fails or
 * the user is logged out, nothing is rendered.
 */
export function TokenUsageBar() {
  const { token, user } = useAuth();
  const [usage, setUsage] = useState<{ usedMs: number; limitMs: number } | null>(null);

  useEffect(() => {
    if (!token) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const me = await authApi.me(token);
        if (cancelled) return;
        setUsage({ usedMs: me.usedMs ?? 0, limitMs: me.limitMs ?? 0 });
      } catch {
        // Silent — auth refresh handles 401s elsewhere; transient
        // network blips shouldn't spam the user with toasts.
      }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);

  if (!usage || !user) return null;

  // Pro tier: just a tiny crown pill, no progress bar.
  if (user.tier === 'pro' || usage.limitMs === 0) {
    return (
      <div className="tubar tubar--pro" title={`${(user.tier ?? 'pro').toUpperCase()} — no daily cap`}>
        <span className="tubar__icon" aria-hidden>★</span>
        <span className="tubar__label">PRO</span>
      </div>
    );
  }

  const pct = Math.min(100, Math.round((usage.usedMs / usage.limitMs) * 100));
  const remaining = Math.max(0, usage.limitMs - usage.usedMs);
  const tone = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
  return (
    <div
      className={`tubar tubar--${tone}`}
      title={`Daily AI streaming budget: ${formatMs(usage.usedMs)} used of ${formatMs(usage.limitMs)} (~${formatMs(remaining)} left)`}
    >
      <div className="tubar__bar">
        <div className="tubar__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="tubar__label">{pct}%</span>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  if (min < 60) return sec ? `${min}m${sec}s` : `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}
