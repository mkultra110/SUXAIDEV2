import { AtelierIcon } from '../ui/AtelierIcon';
import './ActivityBar.css';

/**
 * v0.15.8 — Activity Bar (parité VSCode).
 *
 * Vertical 48px-wide rail anchored on the left. Three icons :
 *   - Files          → switches the sidebar to the file-tree view
 *   - Source Control → switches to the git-status list (badge with
 *                      total dirty count when not zero)
 *   - Search         → fires the existing Cmd+Shift+F SearchInFiles
 *                      modal (no persistent panel for now)
 *
 * Click on the ACTIVE view's icon → collapses the sidebar (same as
 * Cmd+B). Re-clicking re-expands. Matches VSCode's behaviour
 * exactly.
 */

export type SidebarView = 'files' | 'changes';

interface ActivityBarProps {
  view: SidebarView;
  setView: (v: SidebarView) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  /** Number of dirty files — drives the SC badge. */
  dirtyCount: number;
}

export function ActivityBar({
  view,
  setView,
  sidebarOpen,
  setSidebarOpen,
  dirtyCount,
}: ActivityBarProps) {
  const select = (next: SidebarView) => {
    if (view === next && sidebarOpen) {
      // Click on already-active icon → collapse sidebar (VSCode UX).
      setSidebarOpen(false);
      return;
    }
    setView(next);
    if (!sidebarOpen) setSidebarOpen(true);
  };

  const openSearchModal = () => {
    // Synthesize the Ctrl+Shift+F shortcut SearchInFiles already
    // listens for. Avoids creating yet another event channel just for
    // the activity-bar entry point.
    const isMac =
      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F',
        code: 'KeyF',
        ctrlKey: !isMac,
        metaKey: isMac,
        shiftKey: true,
        bubbles: true,
      }),
    );
  };

  return (
    <nav className="actbar" aria-label="Activity bar">
      <button
        type="button"
        className={`actbar__btn ${view === 'files' && sidebarOpen ? 'actbar__btn--active' : ''}`}
        onClick={() => select('files')}
        title="Explorer (Ctrl/Cmd+B)"
        aria-pressed={view === 'files' && sidebarOpen}
      >
        <AtelierIcon name="i-file" size={22} />
      </button>
      <button
        type="button"
        className={`actbar__btn ${view === 'changes' && sidebarOpen ? 'actbar__btn--active' : ''}`}
        onClick={() => select('changes')}
        title="Source Control"
        aria-pressed={view === 'changes' && sidebarOpen}
      >
        <AtelierIcon name="i-git-branch" size={22} />
        {dirtyCount > 0 && (
          <span className="actbar__badge" aria-label={`${dirtyCount} changes`}>
            {dirtyCount > 99 ? '99+' : dirtyCount}
          </span>
        )}
      </button>
      <button
        type="button"
        className="actbar__btn"
        onClick={openSearchModal}
        title="Search in files (Ctrl/Cmd+Shift+F)"
      >
        <AtelierIcon name="i-search" size={22} />
      </button>
      {/* v5.2.2 — SUXAVOIP : numéros temporaires + SMS. Click ouvre
          le panel modal (event suxai:open-sms écouté par SmsPanel).
          Raccourci équivalent : Cmd/Ctrl+Shift+N. */}
      <button
        type="button"
        className="actbar__btn"
        onClick={() => window.dispatchEvent(new CustomEvent('suxai:open-sms'))}
        title="SUXAVOIP — phone numbers (Ctrl/Cmd+Shift+N)"
        aria-label="Open SUXAVOIP panel"
      >
        <AtelierIcon name="i-comment" size={22} />
      </button>
      {/* v0.15.9 — push the gear to the bottom of the bar (parité
          VSCode). Synthetic Cmd+, fires SettingsDialog's existing
          listener, mirroring the search-icon pattern above. */}
      <span className="actbar__spacer" aria-hidden />
      {/* v5.3 — Help / shortcuts cheatsheet. Discreet « ? » in the
          activity bar so users discover the shortcut list without
          having to know Ctrl+Shift+/ exists. */}
      <button
        type="button"
        className="actbar__btn"
        onClick={() => window.dispatchEvent(new CustomEvent('suxai:open-shortcuts'))}
        title="Keyboard shortcuts (Ctrl/Cmd+Shift+/)"
        aria-label="Keyboard shortcuts"
      >
        <span style={{ fontSize: 18, fontWeight: 600, lineHeight: 1, fontFamily: 'var(--font-mono)' }}>?</span>
      </button>
      <button
        type="button"
        className="actbar__btn"
        onClick={() => {
          const isMac =
            typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: ',',
              code: 'Comma',
              ctrlKey: !isMac,
              metaKey: isMac,
              bubbles: true,
            }),
          );
        }}
        title="Settings (Ctrl/Cmd+,)"
      >
        <AtelierIcon name="i-gear" size={22} />
      </button>
    </nav>
  );
}
