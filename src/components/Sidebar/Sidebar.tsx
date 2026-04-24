import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui/Button';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { useToast } from '../ui/Toast';
import './Sidebar.css';

interface TreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeEntry[];
  loaded?: boolean;
  expanded?: boolean;
}

export function Sidebar() {
  const { workspaceRoot, setWorkspaceRoot, openFile, activePath, closeFile, renameFile } =
    useWorkspace();
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
    ];
  };

  const toggleDir = async (entry: TreeEntry) => {
    if (!entry.isDirectory) {
      try {
        const file = await window.suxai.fs.readFile(entry.path);
        openFile({ path: file.path, name: entry.name, content: file.content });
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
        <span className="sidebar__label">Explorer</span>
        <div className="sidebar__header-actions">
          <button className="sidebar__iconbtn" onClick={onOpenFile} title="Open file">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-7-7z M13 2v7h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="sidebar__iconbtn" onClick={onOpenFolder} title="Open folder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
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
  onContextMenu,
}: {
  entries: TreeEntry[];
  depth: number;
  onToggle: (e: TreeEntry) => void;
  activePath: string | null;
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
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onToggle(e)}
              onContextMenu={(ev) => onContextMenu(e, ev)}
            >
              <span className="sidebar__chev" aria-hidden>
                {e.isDirectory ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: e.expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 160ms var(--ease-out)' }}>
                    <path d="M3 2 L7 5 L3 8 Z" fill="currentColor" />
                  </svg>
                ) : null}
              </span>
              <span className="sidebar__entry-icon" aria-hidden>
                {e.isDirectory ? '📁' : iconForFile(e.name)}
              </span>
              <span className="sidebar__entry-name">{e.name}</span>
            </button>
            {e.isDirectory && e.expanded && e.children && (
              <TreeList
                entries={e.children}
                depth={depth + 1}
                onToggle={onToggle}
                activePath={activePath}
                onContextMenu={onContextMenu}
              />
            )}
          </li>
        ))}
    </ul>
  );
}

function iconForFile(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx'].includes(ext)) return '🟦';
  if (['js', 'jsx'].includes(ext)) return '🟨';
  if (ext === 'json') return '🟧';
  if (ext === 'md') return '📄';
  if (['css', 'scss'].includes(ext)) return '🎨';
  return '📄';
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
