import { useWorkspace } from '../../contexts/WorkspaceContext';
import './Breadcrumbs.css';

export function Breadcrumbs() {
  const { activeFile, workspaceRoot } = useWorkspace();

  if (!activeFile) return null;

  // Try to shorten the path by making it relative to the workspace root.
  let rel = activeFile.path;
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/[\\/]+$/, '');
    if (rel.startsWith(root)) rel = rel.slice(root.length);
  }
  rel = rel.replace(/^[\\/]+/, '');
  const segments = rel.split(/[\\/]/).filter(Boolean);

  return (
    <nav className="breadcrumbs" aria-label="file path">
      {segments.map((seg, i) => {
        const last = i === segments.length - 1;
        return (
          <span key={i} className={`breadcrumbs__seg ${last ? 'breadcrumbs__seg--last' : ''}`}>
            {seg}
            {!last && (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="breadcrumbs__sep">
                <path
                  d="M3 2 L7 5 L3 8"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
        );
      })}
    </nav>
  );
}
