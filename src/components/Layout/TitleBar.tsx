import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { UpgradeDialog } from '../UpgradeDialog/UpgradeDialog';
import { SuxaiLogo } from '../ui/SuxaiLogo';
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
          <SuxaiLogo size={20} />
          <span className="titlebar__brand-name">SUXAI</span>
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

      {/* v2.0.4 — window controls (─ □ ✕) are drawn by the OS via
          Electron's titleBarOverlay (Win/Linux) or trafficLightPosition
          (Mac). The custom .titlebar__controls block was rendering
          BEHIND the native overlay → user saw double buttons stacked
          on the same pixels (the native ones are always on top).
          Right zone is now an empty spacer; the OS reserves ~138 px
          here on Win/Linux for its own buttons, and Mac uses the
          left side anyway. */}
      <div className="titlebar__zone titlebar__zone--right" />

      <UpgradeDialog
        token={token}
        open={upgradeOpen}
        onClose={() => setUpgradeOpen(false)}
        onUpgraded={onUpgraded}
      />
    </header>
  );
}
