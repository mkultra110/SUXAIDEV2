import { useMemo, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useGitStatus, type GitStatusCode } from '../../lib/git';
import './SourceControlPanel.css';

/**
 * v0.15.6 — Source Control panel. A flat, sectioned list of every
 * dirty / untracked / conflicting file in the current workspace.
 * Reuses the same useGitStatus hook + IPC as the sidebar badges, so
 * the data refreshes for free on every save / diff accept.
 *
 * Click a row → opens the file in the editor.
 * Currently read-only ; staging / commit / discard come in v0.15.7+.
 */

interface Section {
  id: 'changes' | 'untracked' | 'conflicts';
  label: string;
  codes: GitStatusCode[];
  paths: { path: string; code: GitStatusCode }[];
}

const STATUS_TITLES: Record<GitStatusCode, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  U: 'Untracked',
  R: 'Renamed',
  C: 'Conflict',
};

export function SourceControlPanel() {
  const { workspaceRoot, openFile } = useWorkspace();
  const gitStatus = useGitStatus(workspaceRoot);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const sections = useMemo<Section[]>(() => {
    const changes: Section['paths'] = [];
    const untracked: Section['paths'] = [];
    const conflicts: Section['paths'] = [];
    for (const [path, code] of Object.entries(gitStatus)) {
      if (code === 'C') conflicts.push({ path, code });
      else if (code === 'U') untracked.push({ path, code });
      else changes.push({ path, code });
    }
    const byPath = (a: Section['paths'][number], b: Section['paths'][number]) =>
      a.path.localeCompare(b.path);
    changes.sort(byPath);
    untracked.sort(byPath);
    conflicts.sort(byPath);
    const all: Section[] = [
      { id: 'conflicts', label: 'Conflicts', codes: ['C'], paths: conflicts },
      { id: 'changes',   label: 'Changes',   codes: ['M', 'A', 'D', 'R'], paths: changes },
      { id: 'untracked', label: 'Untracked', codes: ['U'], paths: untracked },
    ];
    return all.filter((s) => s.paths.length > 0);
  }, [gitStatus]);

  const totalDirty = sections.reduce((acc, s) => acc + s.paths.length, 0);

  const onPick = async (absPath: string) => {
    const name = absPath.split(/[\\/]/).pop() ?? absPath;
    try {
      const file = await window.suxai.fs.readFile(absPath);
      openFile({ path: file.path, name, content: file.content });
    } catch {
      // Deleted files can't be opened — silently swallow. Future :
      // show the last-known content via `git show`.
    }
  };

  const relPath = (abs: string): string => {
    if (!workspaceRoot) return abs;
    const root = workspaceRoot.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    const norm = abs.replace(/\\/g, '/');
    if (norm.startsWith(root + '/')) return norm.slice(root.length + 1);
    if (norm === root) return abs.split(/[\\/]/).pop() ?? abs;
    return norm;
  };

  if (!workspaceRoot) {
    return (
      <div className="scp__empty">
        <p>No folder opened</p>
        <p className="scp__hint">Open a folder to see git changes here.</p>
      </div>
    );
  }

  if (totalDirty === 0) {
    return (
      <div className="scp__empty">
        <p>Working tree clean</p>
        <p className="scp__hint">No tracked or untracked changes detected.</p>
      </div>
    );
  }

  return (
    <div className="scp">
      {sections.map((section) => {
        const isCollapsed = collapsed[section.id];
        return (
          <div key={section.id} className="scp__section">
            <button
              type="button"
              className={`scp__section-head scp__section-head--${section.id}`}
              onClick={() => setCollapsed((c) => ({ ...c, [section.id]: !isCollapsed }))}
              aria-expanded={!isCollapsed}
            >
              <span className={`scp__chev ${isCollapsed ? 'scp__chev--collapsed' : ''}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
                </svg>
              </span>
              <span className="scp__section-label">{section.label}</span>
              <span className="scp__section-count">{section.paths.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="scp__list">
                {section.paths.map(({ path, code }) => {
                  const rel = relPath(path);
                  const parts = rel.split('/');
                  const fileName = parts.pop() ?? rel;
                  const dir = parts.join('/');
                  return (
                    <li key={path}>
                      <button
                        type="button"
                        className="scp__row"
                        onClick={() => onPick(path)}
                        title={path}
                      >
                        <span className="scp__row-name">{fileName}</span>
                        {dir && <span className="scp__row-dir">{dir}</span>}
                        <span
                          className={`scp__row-badge scp__row-badge--${code}`}
                          aria-label={STATUS_TITLES[code]}
                        >
                          {code}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
