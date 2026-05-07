/**
 * v5.3.2 — App-wide React ErrorBoundary.
 *
 * Catches render-time exceptions from any descendant. Without this, a
 * single bug (e.g. a malformed prop, a markdown parser explosion, a
 * state machine taking an impossible branch) unmounts the whole tree
 * and the user sees a blank window — they have to kill the process
 * and lose unsaved drafts/conversations.
 *
 * The fallback UI :
 *   - Shows a clean error card with the error message
 *   - "Reload window" button (re-creates the React tree without
 *     killing the Electron process — drafts in localStorage survive)
 *   - "Copy details" button to copy stack trace + UA + version into
 *     the clipboard so the user can paste it into a bug report
 *
 * Logs the full error + componentStack to console.error in DEV ; in
 * production the trace stays in the in-memory state of this boundary
 * (visible after click on "Copy details").
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import './ErrorBoundary.css';

interface Props {
  children: ReactNode;
  /** Optional custom fallback ; if absent, the default card is shown. */
  fallback?: (err: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught render-time error:', error, info);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: '' });
  };

  reload = (): void => {
    try { window.location.reload(); } catch { /* */ }
  };

  copyDetails = async (): Promise<void> => {
    const { error, componentStack } = this.state;
    if (!error) return;
    let version = 'unknown';
    try { version = (await window.suxai?.app?.getVersion?.()) ?? 'unknown'; } catch { /* */ }
    const dump = [
      `SUXAI ${version}`,
      `UA: ${navigator.userAgent}`,
      `Time: ${new Date().toISOString()}`,
      '',
      `Error: ${error.name}: ${error.message}`,
      '',
      'Stack:',
      error.stack ?? '(no stack)',
      '',
      'Component stack:',
      componentStack || '(no component stack)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(dump);
    } catch {
      /* fallback : log to console so the user can copy from devtools */
      // eslint-disable-next-line no-console
      console.log(dump);
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="errboundary__overlay" role="alert">
        <div className="errboundary glass-strong">
          <h2 className="errboundary__title">Something broke</h2>
          <p className="errboundary__msg">
            SUXAI hit an unexpected error and stopped rendering this view.
            Your conversations and drafts on disk are unaffected — reloading
            the window restores them.
          </p>
          <pre className="errboundary__detail">
            {error.name}: {error.message}
          </pre>
          <div className="errboundary__actions">
            <button
              type="button"
              className="errboundary__btn errboundary__btn--primary"
              onClick={this.reload}
            >
              Reload window
            </button>
            <button
              type="button"
              className="errboundary__btn"
              onClick={this.reset}
              title="Try to re-render without reloading"
            >
              Try again
            </button>
            <button
              type="button"
              className="errboundary__btn"
              onClick={() => void this.copyDetails()}
              title="Copy stack trace + version + UA to clipboard"
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
