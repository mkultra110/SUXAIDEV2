import { useEffect, useMemo, useRef, useState } from 'react';
import { AI_MODELS } from '../../config';
import './ModelSelector.css';

interface Props {
  value: string;
  onChange: (modelId: string) => void;
}

export function ModelSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => AI_MODELS.find((m) => m.id === value) ?? AI_MODELS[0], [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={rootRef} className="model-sel">
      <button
        type="button"
        className={`model-sel__trigger ${open ? 'model-sel__trigger--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`model-sel__dot model-sel__dot--${selected.provider}`} />
        <span className="model-sel__name">{selected.label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms var(--ease-out)' }}>
          <path d="M2 4 L5 7 L8 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="model-sel__menu glass-strong" role="listbox">
          {Object.entries(groupByProvider(AI_MODELS)).map(([provider, models]) => (
            <div key={provider} className="model-sel__group">
              <div className="model-sel__group-label">{providerLabel(provider)}</div>
              {models.map((m) => (
                <button
                  key={m.id}
                  className={`model-sel__option ${m.id === value ? 'model-sel__option--active' : ''}`}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  role="option"
                  aria-selected={m.id === value}
                >
                  <span className={`model-sel__dot model-sel__dot--${m.provider}`} />
                  <span className="model-sel__option-name">{m.label}</span>
                  {m.tag && <span className="model-sel__tag">{m.tag}</span>}
                  {m.id === value && (
                    <svg width="12" height="12" viewBox="0 0 12 12" className="model-sel__check">
                      <path d="M2 6.5 L5 9 L10 3.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByProvider<T extends { provider: string }>(items: T[]): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, it) => {
    (acc[it.provider] ??= []).push(it);
    return acc;
  }, {});
}

function providerLabel(p: string): string {
  if (p === 'anthropic') return 'Anthropic (Claude)';
  if (p === 'openai') return 'OpenAI / Google';
  return p;
}
