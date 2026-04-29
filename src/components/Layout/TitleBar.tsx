import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { UpgradeDialog } from '../UpgradeDialog/UpgradeDialog';
import { SuxaiLogo } from '../ui/SuxaiLogo';
import { AtelierIcon } from '../ui/AtelierIcon';
import './TitleBar.css';

export function TitleBar() {
  const { user, token, logout } = useAuth();
  const { workspaceFile, openFile } = useWorkspace();
  const workspaceFileName = workspaceFile
    ? (workspaceFile.split(/[\\/]/).pop() ?? workspaceFile)
    : null;

  // v3.15 — click sur le chip TitleBar = ouvre le .code-workspace
  // dans l'éditeur (utile pour éditer la config workspace).
  const onOpenWorkspaceFile = async () => {
    if (!workspaceFile) return;
    try {
      const f = await window.suxai.fs.readFile(workspaceFile);
      const name = workspaceFile.split(/[\\/]/).pop() ?? workspaceFile;
      openFile({
        path: f.path,
        name,
        content: f.content,
        eol: f.eol,
        encoding: f.encoding,
      });
    } catch {
      /* file moved/deleted — fail silently */
    }
  };
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
          {/* v3.13 — workspace file indicator. Affiché en chip à droite
              du version badge quand un .code-workspace est actif. Le
              tooltip donne le full path. Click ouvre l'item dans
              l'éditeur (utile pour éditer la config du workspace). */}
          {workspaceFileName && (
            <button
              type="button"
              className="titlebar__workspace-file"
              title={`${workspaceFile}\n\nClick to open in editor`}
              onClick={onOpenWorkspaceFile}
            >
              <AtelierIcon name="i-package" size={11} />
              {workspaceFileName}
            </button>
          )}
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
              <AtelierIcon name="i-arrow-up-right" size={14} />
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
