import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { UpgradeDialog } from '../UpgradeDialog/UpgradeDialog';
import './TitleBar.css';

export function TitleBar() {
  const { user, token, logout } = useAuth();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = await window.suxai?.app?.getVersion?.();
        if (alive && typeof v === 'string') setVersion(v);
      } catch {
        /* older preload without app.getVersion — silently ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const displayName = user?.username ?? '';
  const tier = user?.tier ?? 'free';

  const onUpgraded = () => {
    setUpgradeOpen(false);
    // Force a fresh /auth/me + tier render.
    setTimeout(() => window.location.reload(), 400);
  };

  return (
    <header className="titlebar">
      {/* v0.16.4 — 3-zone grid layout (left brand / center user / right
          window controls). Avant : titlebar__drag (flex:1) collait
          tout le reste contre le bord droit, le user cluster se
          retrouvait coincé contre les boutons min/max/X. Maintenant
          le user cluster est dans une zone CENTER auto-width avec
          1fr de chaque côté → naturellement centré dans la barre,
          peu importe la longueur du nom d'utilisateur. */}
      <div className="titlebar__zone titlebar__zone--left titlebar__drag">
        <div className="titlebar__brand">
          <div className="titlebar__dot" />
          <span>SUXAI</span>
          {version && <span className="titlebar__version">v{version}</span>}
        </div>
      </div>

      <div className="titlebar__zone titlebar__zone--center titlebar__drag">
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
                onClick={() => setUpgradeOpen(true)}
                title="Redeem a license key"
              >
                Upgrade
              </button>
            )}
            <span className="titlebar__avatar" aria-hidden>
              {displayName.charAt(0).toUpperCase()}
            </span>
            <span className="titlebar__email" title={displayName}>
              {displayName}
            </span>
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
      </div>

      <div className="titlebar__zone titlebar__zone--right">
        <div className="titlebar__controls">
          <button
            onClick={() => window.suxai.window.minimize()}
            aria-label="Minimize"
            className="titlebar__btn"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect y="4.5" width="10" height="1" fill="currentColor" />
            </svg>
          </button>
          <button
            onClick={() => window.suxai.window.maximizeToggle()}
            aria-label="Maximize"
            className="titlebar__btn"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" />
            </svg>
          </button>
          <button
            onClick={() => window.suxai.window.close()}
            aria-label="Close"
            className="titlebar__btn titlebar__btn--close"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" />
            </svg>
          </button>
        </div>
      </div>

      <UpgradeDialog
        token={token}
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onUpgraded={onUpgraded}
      />
    </header>
  );
}
