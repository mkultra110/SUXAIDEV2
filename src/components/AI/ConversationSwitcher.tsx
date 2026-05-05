import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Conversation } from '../../lib/conversations';
import { AtelierIcon } from '../ui/AtelierIcon';
import './ConversationSwitcher.css';

/**
 * v5.1 — Highlight a substring match inside a title for the search box.
 * Returns the original text untouched when query is empty or no match.
 * Uses case-insensitive matching but preserves original casing.
 */
function highlightMatch(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="cswitch__hl">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

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
  // v5.1 — search query + keyboard nav cursor.
  const [query, setQuery] = useState('');
  const [hoverIdx, setHoverIdx] = useState<number>(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

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
  // v5.1 — filtre par query : matche le titre OU le premier message
  // user (case-insensitive). Les pinned restent en haut DANS leur
  // groupe filtré.
  const matches = (c: Conversation): boolean => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    if (c.title.toLowerCase().includes(q)) return true;
    const firstUser = c.messages.find((m) => m.role === 'user');
    if (firstUser?.content.toLowerCase().includes(q)) return true;
    return false;
  };
  const filteredPinned = pinned.filter(matches);
  const filteredUnpinned = unpinned.filter(matches);
  const sorted = [...filteredPinned, ...filteredUnpinned];

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

  // v5.1 — focus search input on open + reset state.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setHoverIdx(-1);
      return;
    }
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // v5.1 — global key handler : Esc close, Up/Down navigate, Enter select.
  // Utilise sortedRef pour éviter de re-binder à chaque char tapé dans
  // la search input (sortedRef est mis à jour à chaque render mais ne
  // déclenche pas de cleanup/re-add du listener).
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      const list = sortedRef.current;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHoverIdx((i) => (list.length === 0 ? -1 : (i + 1) % list.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHoverIdx((i) => (list.length === 0 ? -1 : (i - 1 + list.length) % list.length));
        return;
      }
      if (e.key === 'Enter') {
        const target = hoverIdxRef.current;
        if (target >= 0 && target < list.length) {
          e.preventDefault();
          onSwitch(list[target].id);
          setOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onSwitch]);
  // hoverIdx in a ref so the keydown handler reads fresh values without
  // re-subscribing on every keystroke.
  const hoverIdxRef = useRef(hoverIdx);
  hoverIdxRef.current = hoverIdx;

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
            {/* v5.1 — search box. Visible dès qu'il y a 4+ conversations
                (sinon overkill). Tape pour filtrer titre + premier
                message ; ↑/↓ pour naviguer ; ↵ pour ouvrir. */}
            {conversations.length >= 4 && (
              <div className="cswitch__search">
                <AtelierIcon name="i-search" size={11} className="cswitch__search-icon" />
                <input
                  ref={searchRef}
                  type="text"
                  className="cswitch__search-input"
                  value={query}
                  placeholder={`Search ${conversations.length} conversations…`}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setHoverIdx(e.target.value ? 0 : -1);
                  }}
                  spellCheck={false}
                  autoComplete="off"
                />
                {query && (
                  <button
                    type="button"
                    className="cswitch__search-clear"
                    onClick={() => {
                      setQuery('');
                      setHoverIdx(-1);
                      searchRef.current?.focus();
                    }}
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>
            )}
            <div className="cswitch__list">
              {sorted.length === 0 && conversations.length === 0 && (
                <div className="cswitch__empty">No conversations yet</div>
              )}
              {sorted.length === 0 && conversations.length > 0 && query && (
                <div className="cswitch__empty">No match for « {query} »</div>
              )}
              {sorted.map((c, i) => (
                <div key={c.id}>
                  {/* v5.0 — divider entre le groupe pinned (en haut)
                      et le groupe recency. Affiché uniquement quand
                      les deux groupes existent ET juste avant le
                      premier non-pinned. */}
                  {filteredPinned.length > 0 && i === filteredPinned.length && filteredUnpinned.length > 0 && (
                    <div className="cswitch__divider" aria-hidden />
                  )}
                <div
                  className={
                    'cswitch__item' +
                    (c.id === activeId ? ' cswitch__item--active' : '') +
                    (c.pinned ? ' cswitch__item--pinned' : '') +
                    (i === hoverIdx ? ' cswitch__item--hover' : '')
                  }
                  onMouseEnter={() => setHoverIdx(i)}
                  ref={(el) => {
                    // v5.1 — auto-scroll l'item hovered (au clavier)
                    // dans le viewport si la liste est trop longue
                    // pour que tout tienne. Critique pour l'UX au
                    // clavier : sans ça, ↓↓↓↓ sortait de l'écran sans
                    // que la liste suive.
                    if (i === hoverIdx && el) {
                      el.scrollIntoView({ block: 'nearest' });
                    }
                  }}
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
                      <span className="cswitch__title">
                        {highlightMatch(c.title, query)}
                      </span>
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
            {/* v5.1 — keyboard hint footer. Apparait uniquement quand
                la search box est visible (= le user a 4+ convs et est
                susceptible de naviguer au clavier). */}
            {conversations.length >= 4 && (
              <div className="cswitch__kbd-hint">
                <kbd>↑</kbd><kbd>↓</kbd> nav · <kbd>↵</kbd> open · <kbd>Esc</kbd> close
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
