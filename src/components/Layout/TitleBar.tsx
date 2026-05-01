import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { UpgradeDialog } from '../UpgradeDialog/UpgradeDialog';
import { SuxaiLogo } from '../ui/SuxaiLogo';
import { AtelierIcon } from '../ui/AtelierIcon';
import './TitleBar.css';

// v4.2.2 — boutons natifs supprimés (titleBarOverlay retiré côté
// Electron) ; on rend nos propres contrôles ici. macOS garde ses
// traffic lights natifs sur la gauche, donc on n'affiche les boutons
// custom QUE sur Win/Linux pour éviter le doublon.
const isMacRenderer =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function TitleBar() {
  const { user, token, logout } = useAuth();
  const { workspaceFile, openFile } = useWorkspace();
  const workspaceFileName = workspaceFile
    ? (workspaceFile.split(/[\\/]/).pop() ?? workspaceFile)
    : null;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    (async () => {
      try {
        const initial = await window.suxai?.window?.isMaximized?.();
        if (alive && typeof initial === 'boolean') setMaximized(initial);
      } catch { /* preload sans isMaximized — ignore */ }
      if (window.suxai?.window?.onMaximizedChange) {
        off = window.suxai.window.onMaximizedChange((m) => setMaximized(m));
      }
    })();
    return () => {
      alive = false;
      off?.();
    };
  }, []);

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

      {/* v4.2.2 — boutons custom React (Win/Linux). titleBarOverlay
          a été retiré côté Electron parce que les boutons natifs
          n'étaient pas pixel-aligned avec la titlebar custom (hauteur
          du hover-region différente, padding interne OS-dépendant).
          Mac garde ses traffic lights natifs (zone gauche), donc on
          n'affiche pas les boutons custom là-bas pour éviter le
          doublon — la zone reste un spacer drag pour permettre le
          déplacement de la fenêtre depuis la droite. */}
      <div className="titlebar__zone titlebar__zone--right">
        {!isMacRenderer && (
          <div className="titlebar__controls" role="group" aria-label="Window controls">
            <button
              type="button"
              className="titlebar__ctrl titlebar__ctrl--min"
              onClick={() => window.suxai?.window?.minimize()}
              aria-label="Minimize"
              title="Minimize"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M1.5 5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="titlebar__ctrl titlebar__ctrl--max"
              onClick={() => window.suxai?.window?.maximizeToggle()}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                {maximized ? (
                  <>
                    <rect x="2.6" y="1.4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
                    <rect x="1.4" y="2.6" width="6" height="6" rx="1" fill="var(--color-bg-surface)" stroke="currentColor" strokeWidth="1.1" />
                  </>
                ) : (
                  <rect x="1.6" y="1.6" width="6.8" height="6.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
                )}
              </svg>
            </button>
            <button
              type="button"
              className="titlebar__ctrl titlebar__ctrl--close"
              onClick={() => window.suxai?.window?.close()}
              aria-label="Close"
              title="Close"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
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
