import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { authApi, ApiError } from '../../api/client';
import './TitleBar.css';

export function TitleBar() {
  const { user, token, logout } = useAuth();
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeemOk, setRedeemOk] = useState(false);

  const onRedeem = async () => {
    if (!token) return;
    const input = window.prompt('Enter your SUXAI license key:');
    if (!input) return;
    setRedeeming(true);
    setRedeemError(null);
    setRedeemOk(false);
    try {
      await authApi.redeemLicense(token, input.trim());
      setRedeemOk(true);
      // Force-refresh the auth state: easiest is to re-fetch /auth/me via a
      // full logout+reload cycle. Instead we just reload the window since
      // every screen is behind AuthContext anyway.
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Unknown error';
      setRedeemError(msg);
    } finally {
      setRedeeming(false);
    }
  };

  const displayName = user?.username ?? '';
  const tier = user?.tier ?? 'free';

  return (
    <header className="titlebar">
      <div className="titlebar__drag">
        <div className="titlebar__brand">
          <div className="titlebar__dot" />
          <span>SUXAI</span>
        </div>
      </div>

      <div className="titlebar__actions">
        {user && (
          <div className="titlebar__user">
            <span
              className={`titlebar__tier titlebar__tier--${tier}`}
              title={
                tier === 'pro'
                  ? 'Pro — unlimited AI'
                  : 'Free — 30 min of AI per day'
              }
            >
              {tier.toUpperCase()}
            </span>
            {tier === 'free' && (
              <button
                className="titlebar__upgrade"
                onClick={onRedeem}
                disabled={redeeming}
                title="Redeem a license key"
              >
                {redeeming ? '…' : 'Upgrade'}
              </button>
            )}
            <span className="titlebar__avatar">
              {displayName.charAt(0).toUpperCase()}
            </span>
            <span className="titlebar__email">{displayName}</span>
            <button className="titlebar__logout" onClick={logout} title="Sign out">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
        <div className="titlebar__controls">
          <button onClick={() => window.suxai.window.minimize()} aria-label="Minimize" className="titlebar__btn">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4.5" width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button onClick={() => window.suxai.window.maximizeToggle()} aria-label="Maximize" className="titlebar__btn">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" /></svg>
          </button>
          <button onClick={() => window.suxai.window.close()} aria-label="Close" className="titlebar__btn titlebar__btn--close">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" /></svg>
          </button>
        </div>
      </div>

      {redeemError && (
        <div className="titlebar__redeem-msg titlebar__redeem-msg--err">{redeemError}</div>
      )}
      {redeemOk && (
        <div className="titlebar__redeem-msg titlebar__redeem-msg--ok">
          Upgrade successful — reloading…
        </div>
      )}
    </header>
  );
}
