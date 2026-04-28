import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui/Button';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { useToast } from '../ui/Toast';
import { useGitStatus, normalizeGitPath, type GitStatusCode } from '../../lib/git';
import {
  setSelectedForCompare,
  getSelectedForCompare,
  clearSelectedForCompare,
  openCompare,
} from '../../lib/compare';
import { iconKindForFile, FileIcon } from '../../lib/file-icon';
import { AtelierIcon } from '../ui/AtelierIcon';
import { SourceControlPanel } from './SourceControlPanel';
import './Sidebar.css';

interface TreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeEntry[];
  loaded?: boolean;
  expanded?: boolean;
}

// v0.15.4 — git badge tooltips. Keys must match GitStatusCode.
const GIT_BADGE_TITLES: Record<GitStatusCode, string> = {
  M: 'Modified',
  A: 'Added (staged)',
  D: 'Deleted',
  U: 'Untracked',
  R: 'Renamed',
  C: 'Conflict',
};

export interface SidebarProps {
  /** v0.15.8 — view is owned by IDELayout so the ActivityBar (a
   *  sibling) can drive it. Optional for backwards compatibility ;
   *  if absent, the sidebar manages an internal state and shows the
   *  legacy header toggle. */
  view?: 'files' | 'changes';
  setView?: (v: 'files' | 'changes') => void;
}

export function Sidebar({ view: viewProp, setView: setViewProp }: SidebarProps = {}) {
  const { workspaceRoot, setWorkspaceRoot, openFile, activePath, closeFile, renameFile } =
    useWorkspace();
  const gitStatus = useGitStatus(workspaceRoot);
  const [internalView, setInternalView] = useState<'files' | 'changes'>('files');
  const view = viewProp ?? internalView;
  const setView = setViewProp ?? setInternalView;
  const dirtyCount = Object.keys(gitStatus).length;
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TreeEntry } | null>(null);
  const toast = useToast();

  const loadRoot = useCallback(async (root: string) => {
    setLoading(true);
    try {
      const entries = await window.suxai.fs.readDir(root);
      setTree(entries.map((e) => ({ ...e, loaded: false, expanded: false })));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (workspaceRoot) void loadRoot(workspaceRoot);
  }, [workspaceRoot, loadRoot]);

  const onOpenFolder = async () => {
    const root = await window.suxai.fs.openFolder();
    if (root) setWorkspaceRoot(root);
  };

  const onOpenFile = async () => {
    const file = await window.suxai.fs.openFile();
    if (!file) return;
    const name = file.path.split(/[\\/]/).pop() ?? file.path;
    openFile({ path: file.path, name, content: file.content });
    const parent = file.path.replace(/[\\/][^\\/]+$/, '');
    if (parent) setWorkspaceRoot(parent);
  };

  const refreshTree = useCallback(async () => {
    if (workspaceRoot) await loadRoot(workspaceRoot);
  }, [workspaceRoot, loadRoot]);

  const handleNewFile = async (parentPath: string) => {
    const name = window.prompt('New file name:');
    if (!name) return;
    try {
      const created = await window.suxai.fs.createFile?.(parentPath, name);
      if (created) {
        const r = await window.suxai.fs.readFile(created);
        openFile({ path: created, name, content: r.content });
        toast.success('Created', name);
        await refreshTree();
      }
    } catch (err) {
      toast.error('Could not create file', (err as Error).message);
    }
  };

  const handleNewFolder = async (parentPath: string) => {
    const name = window.prompt('New folder name:');
    if (!name) return;
    try {
      await window.suxai.fs.createDir?.(parentPath, name);
      toast.success('Created', name);
      await refreshTree();
    } catch (err) {
      toast.error('Could not create folder', (err as Error).message);
    }
  };

  const handleRename = async (entry: TreeEntry) => {
    const name = window.prompt('Rename to:', entry.name);
    if (!name || name === entry.name) return;
    const parent = entry.path.replace(/[\\/][^\\/]+$/, '');
    // Preserve the separator style the parent uses so Windows paths stay
    // uniformly backslashed and POSIX stays forward-slashed.
    const sep = entry.path.includes('\\') ? '\\' : '/';
    const newPath = `${parent}${sep}${name}`;
    try {
      await window.suxai.fs.rename?.(entry.path, newPath);
      if (!entry.isDirectory) renameFile(entry.path, newPath);
      toast.success('Renamed', name);
      await refreshTree();
    } catch (err) {
      toast.error('Rename failed', (err as Error).message);
    }
  };

  const handleDelete = async (entry: TreeEntry) => {
    const ok = window.confirm(`Delete "${entry.name}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await window.suxai.fs.remove?.(entry.path);
      closeFile(entry.path);
      toast.success('Deleted', entry.name);
      await refreshTree();
    } catch (err) {
      toast.error('Delete failed', (err as Error).message);
    }
  };

  const buildMenu = (entry: TreeEntry): (MenuItem | 'separator')[] => {
    const parentPath = entry.isDirectory
      ? entry.path
      : entry.path.replace(/[\\/][^\\/]+$/, '');
    return [
      {
        label: 'New file…',
        onClick: () => handleNewFile(parentPath),
      },
      {
        label: 'New folder…',
        onClick: () => handleNewFolder(parentPath),
      },
      'separator',
      {
        label: 'Rename…',
        hint: 'F2',
        onClick: () => handleRename(entry),
      },
      {
        label: 'Delete',
        danger: true,
        onClick: () => handleDelete(entry),
      },
      'separator',
      {
        label: 'Copy path',
        onClick: () => navigator.clipboard?.writeText(entry.path),
      },
      {
        label: 'Reveal in file explorer',
        onClick: () => {
          window.suxai.fs.revealInFolder?.(entry.path);
        },
      },
      // v0.16.8 — compare two files. Disabled on directories. The
      // "Compare with selected" entry is also disabled when no path
      // is currently selected (the user has to pick one first).
      ...(entry.isDirectory
        ? []
        : ([
            'separator',
            {
              label:
                getSelectedForCompare() === entry.path
                  ? 'Selected ✓ — pick another to compare'
                  : 'Select for compare',
              onClick: () => {
                if (getSelectedForCompare() === entry.path) {
                  clearSelectedForCompare();
                  toast.info('Compare selection cleared');
                } else {
                  setSelectedForCompare(entry.path);
                  toast.info('Selected for compare', entry.name);
                }
              },
            },
            {
              label: 'Compare with selected',
              hint: getSelectedForCompare()
                ? (getSelectedForCompare() ?? '').split(/[\\/]/).pop() ?? ''
                : undefined,
              disabled:
                !getSelectedForCompare() ||
                getSelectedForCompare() === entry.path,
              onClick: () => {
                const a = getSelectedForCompare();
                if (!a || a === entry.path) return;
                openCompare(a, entry.path);
                clearSelectedForCompare();
              },
            },
          ] as (MenuItem | 'separator')[])),
    ];
  };

  const toggleDir = async (entry: TreeEntry) => {
    if (!entry.isDirectory) {
      try {
        const file = await window.suxai.fs.readFile(entry.path);
        openFile({ path: file.path, name: entry.name, content: file.content, eol: file.eol, encoding: file.encoding });
      } catch (err) {
        console.error(err);
      }
      return;
    }
    setTree((prev) => toggleEntry(prev, entry.path));
    if (!entry.loaded) {
      try {
        const children = await window.suxai.fs.readDir(entry.path);
        setTree((prev) =>
          setEntryChildren(
            prev,
            entry.path,
            children.map((c) => ({ ...c, loaded: false, expanded: false })),
          ),
        );
      } catch (err) {
        console.error(err);
      }
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__label">
          {view === 'files' ? 'Explorer' : 'Source Control'}
        </span>
        <div className="sidebar__header-actions">
          {/* v0.15.6 — view toggle. Branch icon = source control,
              file-stack icon = files. The badge on the SC icon
              shows the dirty-file count when not zero. */}
          <button
            className={`sidebar__iconbtn ${view === 'changes' ? 'sidebar__iconbtn--active' : ''}`}
            onClick={() => setView(view === 'files' ? 'changes' : 'files')}
            title={view === 'files' ? 'Source Control' : 'File explorer'}
          >
            {view === 'files' ? (
              <AtelierIcon name="i-git-branch" size={14} />
            ) : (
              <AtelierIcon name="i-file" size={14} />
            )}
            {view === 'files' && dirtyCount > 0 && (
              <span className="sidebar__iconbtn-badge">{dirtyCount}</span>
            )}
          </button>
          <button className="sidebar__iconbtn" onClick={onOpenFile} title="Open file">
            <AtelierIcon name="i-file" size={14} />
          </button>
          <button className="sidebar__iconbtn" onClick={onOpenFolder} title="Open folder">
            <AtelierIcon name="i-folder" size={14} />
          </button>
        </div>
      </div>

      {!workspaceRoot ? (
        <div className="sidebar__empty">
          <p>No folder opened</p>
          <Button variant="secondary" size="sm" onClick={onOpenFolder}>Open folder</Button>
          <Button variant="ghost" size="sm" onClick={onOpenFile}>Open file…</Button>
          <div className="sidebar__hint">or drag &amp; drop a file here</div>
        </div>
      ) : view === 'changes' ? (
        <SourceControlPanel />
      ) : (
        <div className="sidebar__tree" role="tree">
          <div className="sidebar__root" title={workspaceRoot}>
            {workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot}
          </div>
          {loading ? (
            <div className="sidebar__empty"><span>Loading…</span></div>
          ) : (
            <TreeList
              entries={tree}
              depth={0}
              onToggle={toggleDir}
              activePath={activePath}
              gitStatus={gitStatus}
              onContextMenu={(entry, e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, entry });
              }}
            />
          )}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildMenu(menu.entry)}
        />
      )}
    </aside>
  );
}

function TreeList({
  entries,
  depth,
  onToggle,
  activePath,
  gitStatus,
  onContextMenu,
}: {
  entries: TreeEntry[];
  depth: number;
  onToggle: (e: TreeEntry) => void;
  activePath: string | null;
  gitStatus: Record<string, GitStatusCode>;
  onContextMenu: (entry: TreeEntry, e: React.MouseEvent) => void;
}) {
  return (
    <ul className="sidebar__list">
      {entries
        .slice()
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => (
          <li key={e.path}>
            <button
              className={`sidebar__entry ${activePath === e.path ? 'sidebar__entry--active' : ''}`}
              style={{ paddingLeft: 4 + depth * 14 }}
              onClick={() => onToggle(e)}
              onContextMenu={(ev) => onContextMenu(e, ev)}
              draggable={!e.isDirectory}
              onDragStart={(ev) => {
                if (e.isDirectory) return;
                // text/x-suxai-path is the canonical payload — the AI
                // composer reads it and resolves the path via IPC.
                // Also stamp text/plain so dropping the same drag onto
                // a regular textarea (outside SUXAI) just inserts the
                // path string instead of a Chrome-internal blob.
                ev.dataTransfer.setData('text/x-suxai-path', e.path);
                ev.dataTransfer.setData('text/plain', e.path);
                ev.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span
                className="sidebar__chev"
                aria-hidden
                style={e.isDirectory ? {
                  display: 'inline-flex',
                  transform: e.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform var(--dur-quick) var(--ease-out-expo)',
                } : undefined}
              >
                {e.isDirectory ? <AtelierIcon name="i-chevron-right" size={10} /> : null}
              </span>
              <span
                className={`sidebar__entry-icon sidebar__entry-icon--${e.isDirectory ? (e.expanded ? 'folder-open' : 'folder') : iconKindForFile(e.name)}`}
                aria-hidden
              >
                {e.isDirectory ? (
                  e.expanded ? <FolderOpenIcon /> : <FolderIcon />
                ) : (
                  <FileIcon kind={iconKindForFile(e.name)} />
                )}
              </span>
              <span className="sidebar__entry-name">{e.name}</span>
              {(() => {
                if (e.isDirectory) return null;
                // v0.15.5 (audit #7) — readDir returns native paths
                // (Windows backslashes, possibly NFD on macOS); the
                // git IPC normalised everything to forward-slash NFC.
                // Normalise the lookup key so badges actually match.
                const code = gitStatus[normalizeGitPath(e.path)];
                if (!code) return null;
                return (
                  <span
                    className={`sidebar__entry-badge sidebar__entry-badge--${code}`}
                    title={GIT_BADGE_TITLES[code]}
                    aria-label={GIT_BADGE_TITLES[code]}
                  >
                    {code}
                  </span>
                );
              })()}
            </button>
            {e.isDirectory && e.expanded && e.children && (
              <TreeList
                entries={e.children}
                depth={depth + 1}
                onToggle={onToggle}
                activePath={activePath}
                gitStatus={gitStatus}
                onContextMenu={onContextMenu}
              />
            )}
          </li>
        ))}
    </ul>
  );
}

/**
 * v0.17.2 — file-icon system extracted to lib/file-icon.tsx so the
 * editor tabs can render the same coloured icons. iconKindForFile +
 * FileIcon imported at the top.
 */

function FolderIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderOpenIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z"
        fill="currentColor"
        fillOpacity="0.20"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M3 9h18l-2 9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1L3 9z"
        fill="currentColor"
        fillOpacity="0.10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function toggleEntry(list: TreeEntry[], path: string): TreeEntry[] {
  return list.map((e) => {
    if (e.path === path) return { ...e, expanded: !e.expanded };
    if (e.children) return { ...e, children: toggleEntry(e.children, path) };
    return e;
  });
}

function setEntryChildren(list: TreeEntry[], path: string, children: TreeEntry[]): TreeEntry[] {
  return list.map((e) => {
    if (e.path === path) return { ...e, loaded: true, children };
    if (e.children) return { ...e, children: setEntryChildren(e.children, path, children) };
    return e;
  });
}
