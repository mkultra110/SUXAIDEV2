/**
 * v5.3 — Keyboard shortcuts cheatsheet.
 *
 * Searchable list of every shortcut SUXAI ships with, grouped by
 * category. Opens via Command Palette → « Help: Keyboard shortcuts »
 * or via Ctrl+K then Ctrl+S (VSCode parity), or directly Ctrl+/.
 *
 * The list is hand-curated rather than introspected from the actual
 * keybind handlers — those are scattered across IDELayout,
 * EditorPanel, AIPanel, etc. and don't expose a registry. The
 * trade-off : if a shortcut is added/changed in code, this list must
 * be updated manually. Cheap to keep in sync vs. building a full
 * keybind registry.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './ShortcutsCheatsheet.css';

const SHORTCUTS_OPEN_EVENT = 'suxai:open-shortcuts';

export function openShortcutsCheatsheet(): void {
  window.dispatchEvent(new CustomEvent(SHORTCUTS_OPEN_EVENT));
}

interface Shortcut {
  keys: string;
  desc: string;
  group: string;
}

/* eslint-disable prettier/prettier */
const ALL: Shortcut[] = [
  // Navigation
  { group: 'Navigation', keys: 'Ctrl+P',         desc: 'Quick Open file' },
  { group: 'Navigation', keys: 'Ctrl+Shift+P',   desc: 'Command Palette' },
  { group: 'Navigation', keys: 'Ctrl+Shift+F',   desc: 'Search in files' },
  { group: 'Navigation', keys: 'Ctrl+Shift+M',   desc: 'Toggle Problems panel' },
  { group: 'Navigation', keys: 'Ctrl+Shift+U',   desc: 'Toggle Output panel' },
  { group: 'Navigation', keys: 'Ctrl+`',         desc: 'Toggle Terminal' },
  { group: 'Navigation', keys: 'Ctrl+B',         desc: 'Toggle sidebar' },
  { group: 'Navigation', keys: 'F1',             desc: 'Focus Quick Open / Command Palette' },

  // Editor — tabs
  { group: 'Editor', keys: 'Ctrl+S',             desc: 'Save active file' },
  { group: 'Editor', keys: 'Ctrl+Shift+S',       desc: 'Save all dirty files' },
  { group: 'Editor', keys: 'Ctrl+W',             desc: 'Close active tab' },
  { group: 'Editor', keys: 'Ctrl+Shift+T',       desc: 'Reopen last closed tab' },
  { group: 'Editor', keys: 'Ctrl+Tab',           desc: 'Cycle through open tabs' },
  { group: 'Editor', keys: 'Ctrl+1 … Ctrl+9',    desc: 'Jump to tab N' },
  { group: 'Editor', keys: 'Ctrl+N',             desc: 'New untitled file' },

  // Editor — code
  { group: 'Editor', keys: 'Ctrl+/',             desc: 'Toggle line comment (Monaco)' },
  { group: 'Editor', keys: 'Alt+↑ / Alt+↓',      desc: 'Move line up/down' },
  { group: 'Editor', keys: 'Ctrl+D',             desc: 'Add next match to selection' },
  { group: 'Editor', keys: 'Ctrl+0',             desc: 'Reset editor zoom' },
  { group: 'Editor', keys: 'Ctrl+= / Ctrl+-',    desc: 'Zoom in / out' },

  // AI
  { group: 'AI', keys: 'Ctrl+K',                 desc: 'Inline AI edit on selection' },
  { group: 'AI', keys: 'Ctrl+Shift+A',           desc: 'Run Squad Audit (5 agents + Master)' },
  { group: 'AI', keys: 'Ctrl+Shift+N',           desc: 'Open SUXAVOIP panel (phone numbers)' },
  { group: 'AI', keys: 'Cmd/Ctrl+Enter',         desc: 'Send message in composer' },
  { group: 'AI', keys: 'Esc',                    desc: 'Stop streaming response' },

  // Diff
  { group: 'Inline diff', keys: 'Alt+Enter',     desc: 'Accept current hunk' },
  { group: 'Inline diff', keys: 'Shift+Alt+⌫',   desc: 'Reject current hunk' },
  { group: 'Inline diff', keys: 'Alt+J / Alt+K', desc: 'Next / previous hunk' },
  { group: 'Inline diff', keys: 'Ctrl+Enter',    desc: 'Accept all (auto-accept pending)' },
  { group: 'Inline diff', keys: 'Ctrl+⌫',        desc: 'Reject all' },
  { group: 'Inline diff', keys: 'Esc',           desc: 'Close diff (rejects all)' },

  // Source Control
  { group: 'Source Control', keys: 'Ctrl+Shift+G', desc: 'Toggle Source Control view' },
  { group: 'Source Control', keys: 'Ctrl+Enter',   desc: 'Commit (in commit message field)' },

  // Window
  { group: 'Window', keys: 'Ctrl+,',             desc: 'Open Settings' },
  { group: 'Window', keys: 'Ctrl+K Z',           desc: 'Toggle Zen mode' },
  { group: 'Window', keys: 'Ctrl+Shift+/',       desc: 'Show this cheatsheet' },
];
/* eslint-enable prettier/prettier */

function matches(s: Shortcut, q: string): boolean {
  if (!q.trim()) return true;
  const ql = q.toLowerCase();
  return s.keys.toLowerCase().includes(ql) || s.desc.toLowerCase().includes(ql) || s.group.toLowerCase().includes(ql);
}

function highlight(text: string, q: string): ReactNode {
  if (!q.trim()) return text;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const idx = lower.indexOf(ql);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="cheat__hl">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function ShortcutsCheatsheet() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(SHORTCUTS_OPEN_EVENT, handler);
    return () => window.removeEventListener(SHORTCUTS_OPEN_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const filtered = useMemo(() => ALL.filter((s) => matches(s, query)), [query]);
  const groups = useMemo(() => {
    const map = new Map<string, Shortcut[]>();
    for (const s of filtered) {
      const list = map.get(s.group) ?? [];
      list.push(s);
      map.set(s.group, list);
    }
    return [...map.entries()];
  }, [filtered]);

  if (!open) return null;

  return createPortal(
    <div className="cheat__overlay" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
      <div className="cheat glass-strong" onClick={(e) => e.stopPropagation()}>
        <header className="cheat__head">
          <div className="cheat__title">Keyboard shortcuts</div>
          <input
            ref={inputRef}
            type="text"
            className="cheat__search"
            placeholder="Search… (e.g. « squad », « ctrl+s »)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="cheat__close"
            onClick={() => setOpen(false)}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>
        <div className="cheat__body">
          {groups.length === 0 ? (
            <div className="cheat__empty">No match for « {query} »</div>
          ) : (
            groups.map(([group, list]) => (
              <section key={group} className="cheat__group">
                <h3 className="cheat__group-title">{group}</h3>
                <ul className="cheat__list">
                  {list.map((s) => (
                    <li key={`${s.group}:${s.keys}`} className="cheat__row">
                      <span className="cheat__keys">
                        {s.keys.split(/\s+/).map((part, i) => (
                          <kbd key={i}>{highlight(part, query)}</kbd>
                        ))}
                      </span>
                      <span className="cheat__desc">{highlight(s.desc, query)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <footer className="cheat__foot">
          {filtered.length} shortcut{filtered.length === 1 ? '' : 's'}
          {' · '}
          <kbd>Esc</kbd> close
        </footer>
      </div>
    </div>,
    document.body,
  );
}
