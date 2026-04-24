import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import './UpdateDialog.css';

type UpdateInfo = {
  available: boolean;
  version?: string;
  currentVersion?: string;
  notes?: string;
} | null;

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

        {info.notes && <div className="upd__notes">{info.notes}</div>}

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
