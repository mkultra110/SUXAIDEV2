import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ApiError, authApi } from '../../api/client';
import './UpgradeDialog.css';

interface Props {
  token: string | null;
  open: boolean;
  onClose: () => void;
  onUpgraded: () => void;
}

export function UpgradeDialog({ token, open, onClose, onUpgraded }: Props) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setKey('');
      setError(null);
      // focus the input after it mounts
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, onClose]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!token || busy) return;
    const trimmed = key.trim();
    if (!trimmed) {
      setError('Please paste your license key.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.redeemLicense(token, trimmed);
      onUpgraded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not redeem this key.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="upg__overlay" role="dialog" aria-modal="true">
      <div className="upg__card glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="upg__head">
          <div className="upg__icon" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2 L15 9 L22 10 L17 15 L18 22 L12 19 L6 22 L7 15 L2 10 L9 9 Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
                fill="rgba(125,130,248,0.15)"
              />
            </svg>
          </div>
          <div>
            <div className="upg__title">Upgrade to Pro</div>
            <div className="upg__sub">Unlock unlimited AI usage with a license key.</div>
          </div>
        </div>

        <form className="upg__form" onSubmit={submit}>
          <Input
            ref={inputRef}
            label="License key"
            placeholder="suxai-xxxx-xxxx-xxxx-xxxx"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />

          {error && (
            <div className="upg__error" role="alert">
              ⚠ {error}
            </div>
          )}

          <div className="upg__actions">
            <Button type="button" variant="ghost" size="md" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" loading={busy}>
              {busy ? 'Verifying…' : 'Activate Pro'}
            </Button>
          </div>
        </form>

        <div className="upg__foot">
          Don't have a key? Ask the SUXAI owner to grant access to your username.
        </div>
      </div>
    </div>
  );
}
