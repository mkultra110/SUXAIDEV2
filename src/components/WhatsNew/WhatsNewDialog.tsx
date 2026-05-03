/**
 * v5.0 — What's New dialog.
 *
 * Shown ONCE per major version bump. Stores `suxai:last-seen-version` in
 * localStorage ; if missing or older than current major, opens the
 * dialog at app start. Closing it stamps the current version so it
 * doesn't pop again until the next major.
 *
 * The content is a static array per major version — keep it short
 * (3-5 bullets max) and focused on user-visible features. Bug fixes
 * and refactors don't belong here.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './WhatsNewDialog.css';

interface VersionHighlights {
  version: string;
  title: string;
  bullets: { emoji: string; title: string; body: string }[];
}

const HIGHLIGHTS: VersionHighlights[] = [
  {
    version: '5.0.0',
    title: 'SUXAI v5 — l\'agent multi-rounds, instrumenté de bout en bout',
    bullets: [
      {
        emoji: '🎩',
        title: 'Squad multi-agent (5 spécialistes + Master)',
        body:
          'Architect, Auditor, Improver, Performance, Security streamés en parallèle ' +
          'sur ton fichier actif. Le Master synthétise leurs reports en un plan ' +
          'd\'action priorisé. Cmd+Shift+A.',
      },
      {
        emoji: '⚡',
        title: 'Round agent visible en temps réel',
        body:
          'La pill "round 3/8" à côté du spinner te montre où en est l\'agent ' +
          'pendant qu\'il chaîne ses tool_use. Plus de surprise quand il fait ' +
          'plusieurs passes.',
      },
      {
        emoji: '📌',
        title: 'Pin tes conversations importantes',
        body:
          'Les conversations pinnées flottent au-dessus du switcher. Idéal pour ' +
          'la conversation d\'architecture, le bug récurrent, le brainstorm.',
      },
      {
        emoji: '🩺',
        title: 'Server health en bandeau de statut',
        body:
          'Pill discrète qui apparaît quand le VPS est dégradé ou injoignable, ' +
          'silencieuse sinon. /health remonte maintenant disque + mémoire + ' +
          'uptime — alerte avant que ça plante.',
      },
      {
        emoji: '🛡️',
        title: 'Hardening serveur',
        body:
          'logrotate auto sur /opt/suxai/logs/*, journald cappé à 500MB, prune ' +
          'auto des vieux installeurs. Le disque-plein de fin avril ne reviendra pas.',
      },
    ],
  },
];

const STORAGE_KEY = 'suxai:last-seen-version';

function majorOf(v: string): number {
  const m = /^(\d+)/.exec(v);
  return m ? parseInt(m[1], 10) : 0;
}

export function WhatsNewDialog() {
  const [open, setOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string>('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = await window.suxai?.app?.getVersion?.();
        if (!alive || typeof v !== 'string') return;
        setCurrentVersion(v);
        const lastSeen = localStorage.getItem(STORAGE_KEY);
        // Show only on a major bump (5.x.x → 6.x.x etc.). Patches and
        // minors don't pop the dialog. First-launch (no lastSeen) also
        // shows it.
        if (!lastSeen || majorOf(lastSeen) < majorOf(v)) {
          setOpen(true);
        }
      } catch { /* preload pas prêt — on ignore */ }
    })();
    return () => { alive = false; };
  }, []);

  const close = () => {
    setOpen(false);
    if (currentVersion) {
      try { localStorage.setItem(STORAGE_KEY, currentVersion); } catch { /* */ }
    }
  };

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  // Pick the highlights matching the current major. Falls back to the
  // newest entry if no exact match.
  const major = majorOf(currentVersion);
  const highlights =
    HIGHLIGHTS.find((h) => majorOf(h.version) === major) ?? HIGHLIGHTS[0];

  return createPortal(
    <div className="whatsnew__overlay" role="dialog" aria-modal="true" onClick={close}>
      <div className="whatsnew glass-strong" onClick={(e) => e.stopPropagation()}>
        <header className="whatsnew__head">
          <span className="whatsnew__badge">v{highlights.version}</span>
          <h2 className="whatsnew__title">{highlights.title}</h2>
          <button
            type="button"
            className="whatsnew__close"
            onClick={close}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>
        <ul className="whatsnew__list">
          {highlights.bullets.map((b) => (
            <li key={b.title} className="whatsnew__item">
              <span className="whatsnew__emoji" aria-hidden>{b.emoji}</span>
              <div className="whatsnew__body">
                <h3>{b.title}</h3>
                <p>{b.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <footer className="whatsnew__foot">
          <button type="button" className="whatsnew__cta" onClick={close}>
            Allons-y
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
