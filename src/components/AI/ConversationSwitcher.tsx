import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation } from '../../lib/conversations';
import './ConversationSwitcher.css';

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  /** First call requests deletion (item enters pending state). */
  onDelete: (id: string) => void;
  /** Second click commits the deletion. */
  onConfirmDelete: (id: string) => void;
  /** Id currently armed for deletion (shown in confirmation state). */
  pendingDeleteId: string | null;
  onRename: (id: string, title: string) => void;
}

export function ConversationSwitcher({
  conversations,
  activeId,
  onSwitch,
  onNew,
  onDelete,
  onConfirmDelete,
  pendingDeleteId,
  onRename,
}: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const active = conversations.find((c) => c.id === activeId);
  // Most-recently-updated first.
  const sorted = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const position = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setCoords({ top: r.bottom + 6, left: r.left, width: Math.max(r.width, 280) });
  };

  useLayoutEffect(() => {
    if (open) position();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => position();
    const onResize = () => position();
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
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) {
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
    <div className="cswitch">
      <button
        ref={triggerRef}
        type="button"
        className={`cswitch__trigger ${open ? 'cswitch__trigger--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={active?.title}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M21 12a9 9 0 1 1-3-6.7L21 3v6h-6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="cswitch__name">{active?.title ?? 'New conversation'}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
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
            className="cswitch__menu glass-strong"
            role="listbox"
            style={{ top: coords.top, left: coords.left, minWidth: coords.width }}
          >
            <div className="cswitch__list">
              {sorted.length === 0 && (
                <div className="cswitch__empty">No conversations yet</div>
              )}
              {sorted.map((c) => (
                <div
                  key={c.id}
                  className={`cswitch__item ${c.id === activeId ? 'cswitch__item--active' : ''}`}
                >
                  {editingId === c.id ? (
                    <input
                      type="text"
                      className="cswitch__rename"
                      defaultValue={c.title}
                      autoFocus
                      onBlur={(e) => {
                        onRename(c.id, e.target.value);
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          onRename(c.id, e.currentTarget.value);
                          setEditingId(null);
                        } else if (e.key === 'Escape') {
                          setEditingId(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="cswitch__pick"
                      onClick={() => {
                        onSwitch(c.id);
                        setOpen(false);
                      }}
                      onDoubleClick={() => setEditingId(c.id)}
                      title="Click to switch · double-click to rename"
                    >
                      <span className="cswitch__title">{c.title}</span>
                      <span className="cswitch__meta">
                        {c.messages.length} msg
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={`cswitch__del${pendingDeleteId === c.id ? ' cswitch__del--armed' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (pendingDeleteId === c.id) onConfirmDelete(c.id);
                      else onDelete(c.id);
                    }}
                    title={
                      pendingDeleteId === c.id
                        ? 'Click again to confirm deletion'
                        : 'Delete this conversation'
                    }
                    aria-label={
                      pendingDeleteId === c.id
                        ? `Confirm delete ${c.title}`
                        : `Delete ${c.title}`
                    }
                  >
                    {pendingDeleteId === c.id ? (
                      <span style={{ fontSize: 10, fontWeight: 600 }}>Sure?</span>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="cswitch__new"
              onClick={() => {
                onNew();
                setOpen(false);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              New conversation
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
