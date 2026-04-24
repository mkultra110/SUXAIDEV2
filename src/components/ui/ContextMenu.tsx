import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void | Promise<void>;
}

interface Props {
  x: number;
  y: number;
  items: (MenuItem | 'separator')[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // Clip to viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + rect.width > window.innerWidth - 8) nx = window.innerWidth - rect.width - 8;
    if (ny + rect.height > window.innerHeight - 8) ny = window.innerHeight - rect.height - 8;
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="ctxmenu glass-strong"
      style={{ top: pos.y, left: pos.x }}
      role="menu"
    >
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="ctxmenu__sep" />
        ) : (
          <button
            key={i}
            type="button"
            className={`ctxmenu__item ${it.danger ? 'ctxmenu__item--danger' : ''}`}
            disabled={it.disabled}
            onClick={async () => {
              onClose();
              try {
                await it.onClick();
              } catch (err) {
                console.error('[ctxmenu] action failed:', err);
              }
            }}
            role="menuitem"
          >
            <span className="ctxmenu__label">{it.label}</span>
            {it.hint && <span className="ctxmenu__hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
