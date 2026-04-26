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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7z M13 2v7h7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button
        type="button"
        className={`actbar__btn ${view === 'changes' && sidebarOpen ? 'actbar__btn--active' : ''}`}
        onClick={() => select('changes')}
        title="Source Control"
        aria-pressed={view === 'changes' && sidebarOpen}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="6" cy="19" r="2" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="18" cy="12" r="2" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M6 7v10 M8 19h2a4 4 0 0 0 4-4v-3 M8 5h2a4 4 0 0 1 4 4v3"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </nav>
  );
}
