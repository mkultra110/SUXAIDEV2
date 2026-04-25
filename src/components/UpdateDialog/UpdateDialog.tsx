import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { renderMarkdown } from '../../lib/markdown';
import './UpdateDialog.css';

type UpdateInfo = {
  available: boolean;
  version?: string;
  currentVersion?: string;
  notes?: string;
} | null;

// Stash the changelog we're about to apply so the app can show a
// "What's new" dialog after restart. Keyed by version so users only
// see each changelog once. Cleared after they dismiss the post-update
// dialog. Lives in localStorage rather than safeStorage because it's
// not sensitive and we want it accessible synchronously at boot.
const PENDING_CHANGELOG_KEY = 'suxai.pendingChangelog';
const SEEN_CHANGELOG_KEY = 'suxai.seenChangelogVersion';

function stashPendingChangelog(version: string, notes: string | undefined): void {
  try {
    localStorage.setItem(
      PENDING_CHANGELOG_KEY,
      JSON.stringify({ version, notes: notes ?? '', stashedAt: Date.now() }),
    );
  } catch {
    /* localStorage full / disabled — non-fatal */
  }
}

export function UpdateDialog() {
  const [info, setInfo] = useState<UpdateInfo>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>('idle');
  const [progress, setProgress] = useState<{ percent: number; transferred: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.suxai.update.check();
        if (cancelled || !res || !res.available) return;
        setInfo(res);
        setOpen(true);
      } catch (err) {
        // silent — update check is best-effort
        console.warn('[update] check failed:', err);
      }
    })();
    const offStatus = window.suxai.update.onStatus((s) => setStatus(s));
    const offProgress = window.suxai.update.onProgress((p) => setProgress(p));
    return () => {
      cancelled = true;
      offStatus();
      offProgress();
    };
  }, []);

  const install = async () => {
    setError(null);
    setBusy(true);
    // Stash the changelog now — the installer is about to relaunch
    // SUXAI. After the restart, WhatsNewDialog will read this back
    // and surface the release notes to the user.
    if (info?.version) stashPendingChangelog(info.version, info.notes);
    try {
      await window.suxai.update.downloadAndInstall();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open || !info?.available) return null;

  const percent = progress ? Math.min(100, Math.round(progress.percent * 100)) : 0;

  return createPortal(
    <div className="upd__overlay" role="dialog" aria-modal="true">
      <div className="upd__card glass-strong">
        <div className="upd__head">
          <div className="upd__icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="upd__title">Update available</div>
            <div className="upd__ver">
              v{info.currentVersion} → <strong>v{info.version}</strong>
            </div>
          </div>
        </div>

        {info.notes && (
          <div className="upd__notes-wrap">
            <div className="upd__notes-title">What's new</div>
            <div
              className="upd__notes upd__notes--md"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(info.notes) }}
            />
          </div>
        )}

        {busy && (
          <div className="upd__progress">
            <div className="upd__bar">
              <div className="upd__fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="upd__progress-meta">
              <span>{status}</span>
              <span>{percent}%</span>
            </div>
          </div>
        )}

        {error && <div className="upd__error">⚠ {error}</div>}

        <div className="upd__actions">
          <Button variant="ghost" size="md" onClick={() => setOpen(false)} disabled={busy}>
            Later
          </Button>
          <Button variant="primary" size="md" onClick={install} loading={busy}>
            {busy ? 'Installing…' : 'Install & restart'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface PendingChangelog {
  version: string;
  notes: string;
  stashedAt: number;
}

/**
 * "What's new" splash that appears once after an in-place update.
 * Reads the changelog stashed by UpdateDialog at install time and
 * shows it the next time the app boots (post-restart). Deduped via
 * `suxai.seenChangelogVersion` so the user only sees each version's
 * notes once.
 *
 * Mount this near the app root alongside <UpdateDialog />.
 */
export function WhatsNewDialog() {
  const [pending, setPending] = useState<PendingChangelog | null>(null);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(PENDING_CHANGELOG_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: PendingChangelog | null = null;
    try {
      const obj = JSON.parse(raw) as Partial<PendingChangelog>;
      if (typeof obj.version === 'string') {
        parsed = {
          version: obj.version,
          notes: typeof obj.notes === 'string' ? obj.notes : '',
          stashedAt: typeof obj.stashedAt === 'number' ? obj.stashedAt : 0,
        };
      }
    } catch {
      /* malformed stash — drop it */
      try { localStorage.removeItem(PENDING_CHANGELOG_KEY); } catch { /* */ }
      return;
    }
    if (!parsed) return;
    // Skip if the user already saw the changelog for this version.
    let seen: string | null = null;
    try { seen = localStorage.getItem(SEEN_CHANGELOG_KEY); } catch { /* */ }
    if (seen === parsed.version) {
      try { localStorage.removeItem(PENDING_CHANGELOG_KEY); } catch { /* */ }
      return;
    }
    setPending(parsed);
  }, []);

  const dismiss = () => {
    if (!pending) return;
    try {
      localStorage.setItem(SEEN_CHANGELOG_KEY, pending.version);
      localStorage.removeItem(PENDING_CHANGELOG_KEY);
    } catch { /* */ }
    setPending(null);
  };

  if (!pending) return null;

  return createPortal(
    <div
      className="upd__overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="whatsnew-title"
      onClick={dismiss}
    >
      <div className="upd__card glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="upd__head">
          <div className="upd__icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2 L14 9 L21 11 L14 13 L12 21 L10 13 L3 11 L10 9 Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <div>
            <div className="upd__title" id="whatsnew-title">
              You're on v{pending.version}
            </div>
            <div className="upd__ver">Here's what's new in this release</div>
          </div>
        </div>

        {pending.notes ? (
          <div
            className="upd__notes upd__notes--md"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(pending.notes) }}
          />
        ) : (
          <div className="upd__notes upd__notes--empty">
            (No release notes were attached to this build.)
          </div>
        )}

        <div className="upd__actions">
          <Button variant="primary" size="md" onClick={dismiss}>
            Got it
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
