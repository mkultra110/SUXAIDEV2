import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation } from '../../lib/conversations';
import { AtelierIcon } from '../ui/AtelierIcon';
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
  /** v5.0 — toggle pinned. Pinned conversations float at the top of
   *  the list, separated from the recency-sorted ones by a divider. */
  onTogglePin?: (id: string) => void;
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
  onTogglePin,
}: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const active = conversations.find((c) => c.id === activeId);
  // v5.0 — pinned d'abord (les + récents en premier dans le groupe pinné),
  // puis les non-pinnés sortés par recency. Le séparateur est rendu
  // entre les deux groupes via le flag .cswitch__divider plus bas.
  const pinned = conversations
    .filter((c) => c.pinned)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const unpinned = conversations
    .filter((c) => !c.pinned)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sorted = [...pinned, ...unpinned];

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
        <AtelierIcon name="i-comment" size={12} />
        <span className="cswitch__name">{active?.title ?? 'New conversation'}</span>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform var(--dur-quick) var(--ease-out-expo)',
          }}
        >
          <AtelierIcon name="i-chevron-down" size={10} />
        </span>
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
              {sorted.map((c, i) => (
                <div key={c.id}>
                  {/* v5.0 — divider entre le groupe pinned (en haut)
                      et le groupe recency. Affiché uniquement quand
                      les deux groupes existent ET juste avant le
                      premier non-pinned. */}
                  {pinned.length > 0 && i === pinned.length && unpinned.length > 0 && (
                    <div className="cswitch__divider" aria-hidden />
                  )}
                <div
                  className={`cswitch__item ${c.id === activeId ? 'cswitch__item--active' : ''}${c.pinned ? ' cswitch__item--pinned' : ''}`}
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
                  {/* v5.0 — bouton pin. Click toggle le flag pinned.
                      Visible en permanence ; couleur pleine si déjà
                      pinned, contour seulement sinon. */}
                  {onTogglePin && (
                    <button
                      type="button"
                      className={`cswitch__pin${c.pinned ? ' cswitch__pin--on' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin(c.id);
                      }}
                      title={c.pinned ? 'Unpin' : 'Pin to top'}
                      aria-label={c.pinned ? `Unpin ${c.title}` : `Pin ${c.title}`}
                    >
                      <AtelierIcon name="i-pin" size={11} />
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
                      <AtelierIcon name="i-close" size={12} />
                    )}
                  </button>
                </div>
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
              <AtelierIcon name="i-plus" size={14} />
              New conversation
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
