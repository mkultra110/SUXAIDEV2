import { useWorkspace } from '../../contexts/WorkspaceContext';
import { AtelierIcon } from '../ui/AtelierIcon';
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
              <AtelierIcon name="i-chevron-right" size={10} className="breadcrumbs__sep" />
            )}
          </span>
        );
      })}
    </nav>
  );
}
