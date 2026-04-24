import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AI_MODELS } from '../../config';
import './ModelSelector.css';

interface Props {
  value: string;
  onChange: (modelId: string) => void;
}

export function ModelSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(
    () => AI_MODELS.find((m) => m.id === value) ?? AI_MODELS[0],
    [value],
  );

  const positionMenu = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setCoords({
      top: r.bottom + 6,
      right: window.innerWidth - r.right,
    });
  };

  useLayoutEffect(() => {
    if (open) positionMenu();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => positionMenu();
    const onResize = () => positionMenu();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="model-sel">
      <button
        ref={triggerRef}
        type="button"
        className={`model-sel__trigger ${open ? 'model-sel__trigger--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`model-sel__dot model-sel__dot--${selected.provider}`} />
        <span className="model-sel__name">{selected.label}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          style={{
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 180ms var(--ease-out)',
          }}
        >
          <path
            d="M2 4 L5 7 L8 4"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && coords &&
        createPortal(
          <div
            ref={menuRef}
            className="model-sel__menu glass-strong"
            role="listbox"
            style={{ top: coords.top, right: coords.right }}
          >
            {Object.entries(groupByProvider(AI_MODELS)).map(([provider, models]) => (
              <div key={provider} className="model-sel__group">
                <div className="model-sel__group-label">{providerLabel(provider)}</div>
                {models.map((m) => (
                  <button
                    key={m.id}
                    className={`model-sel__option ${
                      m.id === value ? 'model-sel__option--active' : ''
                    }`}
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
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        className="model-sel__check"
                      >
                        <path
                          d="M2 6.5 L5 9 L10 3.5"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>,
          document.body,
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
