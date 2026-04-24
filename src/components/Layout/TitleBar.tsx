import { useAuth } from '../../contexts/AuthContext';
import './TitleBar.css';

export function TitleBar() {
  const { user, logout } = useAuth();

  return (
    <header className="titlebar">
      <div className="titlebar__drag">
        <div className="titlebar__brand">
          <div className="titlebar__dot" />
          <span>SUXAI</span>
        </div>
      </div>

      <div className="titlebar__actions">
        {user && (
          <div className="titlebar__user">
            <span className="titlebar__avatar">{user.email.charAt(0).toUpperCase()}</span>
            <span className="titlebar__email">{user.email}</span>
            <button className="titlebar__logout" onClick={logout} title="Sign out">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
        <div className="titlebar__controls">
          <button onClick={() => window.suxai.window.minimize()} aria-label="Minimize" className="titlebar__btn">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4.5" width="10" height="1" fill="currentColor" /></svg>
          </button>
          <button onClick={() => window.suxai.window.maximizeToggle()} aria-label="Maximize" className="titlebar__btn">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none" /></svg>
          </button>
          <button onClick={() => window.suxai.window.close()} aria-label="Close" className="titlebar__btn titlebar__btn--close">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" /></svg>
          </button>
        </div>
      </div>
    </header>
  );
}
