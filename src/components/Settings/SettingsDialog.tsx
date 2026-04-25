import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { useSettings } from '../../lib/settings';
import { AI_MODELS } from '../../config';
import './SettingsDialog.css';

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [settings, update] = useSettings();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('suxai:open-settings', onOpen);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('suxai:open-settings', onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="settings__overlay" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
      <div className="settings__card glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <div>
            <div className="settings__title">Settings</div>
            <div className="settings__sub">Preferences saved locally on this device.</div>
          </div>
          <button
            type="button"
            className="settings__close"
            aria-label="Close"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="settings__body">
          <Section title="Editor">
            <Row label="Font size">
              <input
                type="number"
                min={10}
                max={24}
                value={settings.fontSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const clamped = Number.isFinite(n) ? Math.max(10, Math.min(24, n)) : 13;
                  update({ fontSize: clamped });
                }}
                className="settings__input"
              />
              <span className="settings__unit">px</span>
            </Row>
            <Row label="Tab size">
              <input
                type="number"
                min={1}
                max={8}
                value={settings.tabSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const clamped = Number.isFinite(n) ? Math.max(1, Math.min(8, Math.trunc(n))) : 2;
                  update({ tabSize: clamped });
                }}
                className="settings__input"
              />
              <span className="settings__unit">spaces</span>
            </Row>
            <Row label="Word wrap">
              <Toggle
                value={settings.wordWrap}
                onChange={(v) => update({ wordWrap: v })}
              />
            </Row>
            <Row label="Minimap">
              <Toggle
                value={settings.minimap}
                onChange={(v) => update({ minimap: v })}
              />
            </Row>
            <Row label="Tab autocomplete">
              <Toggle
                value={settings.tabCompletion}
                onChange={(v) => update({ tabCompletion: v })}
              />
            </Row>
          </Section>

          <Section title="AI">
            <Row label="Default model">
              <select
                value={settings.defaultModelId}
                onChange={(e) => update({ defaultModelId: e.target.value })}
                className="settings__select"
              >
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Row>
          </Section>
        </div>

        <div className="settings__foot">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="settings__section">
      <div className="settings__section-title">{title}</div>
      <div className="settings__section-body">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="settings__row">
      <span className="settings__row-label">{label}</span>
      <div className="settings__row-control">{children}</div>
    </label>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={`settings__toggle ${value ? 'settings__toggle--on' : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className="settings__toggle-thumb" />
    </button>
  );
}
