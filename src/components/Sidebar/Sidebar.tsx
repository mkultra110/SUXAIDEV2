import { useCallback, useEffect, useState } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button } from '../ui/Button';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { useToast } from '../ui/Toast';
import { useGitStatus, useGitStatusMulti, normalizeGitPath, type GitStatusCode } from '../../lib/git';
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
  const {
    workspaceRoots,
    setWorkspaceRoot, addWorkspaceRoot,
    openFile, activePath, closeFile, renameFile,
  } = useWorkspace();
  // v3.11 — agrège le git status de tous les workspace roots pour le
  // badge du SC icon dans le header. Le hook fetche par root puis
  // merge ; un suxai:git-refresh ciblé sur une seule root invalide
  // sa slice et reload elle seule.
  const aggregatedStatus = useGitStatusMulti(workspaceRoots);
  const [internalView, setInternalView] = useState<'files' | 'changes'>('files');
  const view = viewProp ?? internalView;
  const setView = setViewProp ?? setInternalView;
  const dirtyCount = Object.keys(aggregatedStatus).length;
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TreeEntry } | null>(null);
  const toast = useToast();

  const onOpenFolder = async () => {
    const root = await window.suxai.fs.openFolder();
    if (root) setWorkspaceRoot(root);
  };

  const onAddFolder = async () => {
    const root = await window.suxai.fs.openFolder();
    if (!root) return;
    addWorkspaceRoot(root);
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    toast.success('Folder added', name);
  };

  const onOpenFile = async () => {
    const file = await window.suxai.fs.openFile();
    if (!file) return;
    const name = file.path.split(/[\\/]/).pop() ?? file.path;
    openFile({ path: file.path, name, content: file.content });
    const parent = file.path.replace(/[\\/][^\\/]+$/, '');
    if (parent) setWorkspaceRoot(parent);
  };

  // v3.10 — refreshTree devient un broadcast d'event que chaque
  // RootTree écoute et resync. Refresh all au lieu d'un seul root :
  // après un rename / delete / new, on ne sait pas toujours quel root
  // est affecté (les paths peuvent traverser), et le coût d'un fs.readDir
  // par root est négligeable.
  const refreshTree = useCallback(() => {
    window.dispatchEvent(new CustomEvent('suxai:tree-refresh'));
  }, []);

  const handleNewFile = async (parentPath: string) => {
    const name = window.prompt('New file name:');
    if (!name) return;
    try {
      const created = await window.suxai.fs.createFile?.(parentPath, name);
      if (created) {
        const r = await window.suxai.fs.readFile(created);
        openFile({ path: created, name, content: r.content });
        toast.success('Created', name);
        refreshTree();
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
      refreshTree();
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
      refreshTree();
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
      refreshTree();
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

  // v3.10 — `toggleDir` lives inside each <RootTree> so each one
  // owns its tree expansion state. The Sidebar parent only forwards
  // the file-open callback (when a leaf is clicked) and the
  // context-menu trigger (which lifts to the parent for portal
  // positioning).
  const onLeafOpen = useCallback(
    async (entry: TreeEntry) => {
      try {
        const file = await window.suxai.fs.readFile(entry.path);
        openFile({
          path: file.path,
          name: entry.name,
          content: file.content,
          eol: file.eol,
          encoding: file.encoding,
        });
      } catch (err) {
        console.error(err);
      }
    },
    [openFile],
  );

  const onContextMenu = useCallback((entry: TreeEntry, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

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

      {workspaceRoots.length === 0 ? (
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
          {workspaceRoots.map((root) => (
            <RootTree
              key={root}
              root={root}
              showHeader={workspaceRoots.length > 1}
              activePath={activePath}
              onLeafOpen={onLeafOpen}
              onContextMenu={onContextMenu}
            />
          ))}
          {/* v3.10 — utility row at the bottom, only shown when at
              least one root is open. The « Add folder » CTA matches
              VSCode's Explorer footer affordance. */}
          <div className="sidebar__tree-footer">
            <button type="button" className="sidebar__add-folder" onClick={onAddFolder}>
              <AtelierIcon name="i-plus" size={11} />
              Add folder to workspace
            </button>
          </div>
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

/**
 * v3.10 — Multi-root section. Each workspace root gets its own
 * `<RootTree>` instance, with private tree state + git status + load
 * lifecycle. The Sidebar parent maps workspaceRoots → RootTree and
 * lifts the leaf-click + context-menu callbacks. A global event
 * `suxai:tree-refresh` (no payload) tells every RootTree to reload —
 * fired after newFile / rename / delete by the Sidebar handlers.
 *
 * `showHeader` toggles the collapsible folder header. When the
 * workspace has a single root it stays on, since v3.9 always showed
 * the root name as a static breadcrumb anyway. We get a free
 * collapse/expand affordance with no visual regression.
 */
function RootTree({
  root,
  showHeader,
  activePath,
  onLeafOpen,
  onContextMenu,
}: {
  root: string;
  showHeader: boolean;
  activePath: string | null;
  onLeafOpen: (entry: TreeEntry) => void;
  onContextMenu: (entry: TreeEntry, e: React.MouseEvent) => void;
}) {
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const gitStatus = useGitStatus(root);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await window.suxai.fs.readDir(root);
      setTree(entries.map((e) => ({ ...e, loaded: false, expanded: false })));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => { void loadRoot(); }, [loadRoot]);

  // Refresh on cross-tree event broadcast. No-payload event means
  // every RootTree resyncs — coût négligeable (1 fs.readDir per root)
  // et ça évite de devoir router l'event sur le bon root depuis les
  // handlers Sidebar.
  useEffect(() => {
    const handler = () => { void loadRoot(); };
    window.addEventListener('suxai:tree-refresh', handler);
    return () => window.removeEventListener('suxai:tree-refresh', handler);
  }, [loadRoot]);

  // v3.18 — Reveal-in-sidebar : walk depuis la root jusqu'à la
  // target path, expand chaque dir intermédiaire (lazy-load via
  // fs.readDir si pas encore chargé), puis scroll-into-view +
  // flash-highlight le button de la target. Listener scopé à ce
  // RootTree ; il filtre les events qui ne sont pas pour son root.
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<{ path: string }>).detail;
      if (!detail?.path) return;
      const target = detail.path.replace(/\\/g, '/');
      const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!target.startsWith(rootNorm + '/') && target !== rootNorm) return;
      const rel = target.slice(rootNorm.length).replace(/^\/+/, '');
      const segments = rel.split('/').filter(Boolean);
      if (segments.length === 0) return;

      // Walk down the tree, expanding+loading each directory until
      // we reach the target. Re-fetch the tree state via setTree's
      // updater pattern so each step sees the latest.
      let cumulative = rootNorm;
      for (let i = 0; i < segments.length - 1; i++) {
        cumulative += '/' + segments[i];
        // Load children if not yet
        let needLoad = false;
        await new Promise<void>((resolve) => {
          setTree((prev) => {
            // Find entry by recursively walking
            const findEntry = (list: TreeEntry[], path: string): TreeEntry | null => {
              for (const e of list) {
                const eNorm = e.path.replace(/\\/g, '/');
                if (eNorm === path) return e;
                if (e.children) {
                  const child = findEntry(e.children, path);
                  if (child) return child;
                }
              }
              return null;
            };
            const entry = findEntry(prev, cumulative);
            if (entry && !entry.loaded) needLoad = true;
            // Mark expanded regardless (will load below if needed)
            if (entry && !entry.expanded) {
              return toggleEntry(prev, entry.path);
            }
            return prev;
          });
          resolve();
        });
        if (needLoad) {
          try {
            const children = await window.suxai.fs.readDir(cumulative);
            setTree((prev) =>
              setEntryChildren(
                prev,
                cumulative,
                children.map((c) => ({ ...c, loaded: false, expanded: false })),
              ),
            );
          } catch { /* swallow */ }
        }
      }

      // Scroll + flash the target button.
      requestAnimationFrame(() => {
        const escaped = target.replace(/"/g, '\\"');
        const btn = document.querySelector<HTMLElement>(
          `[data-tree-path="${escaped}"]`,
        );
        if (btn) {
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          btn.classList.add('sidebar__entry--flash');
          setTimeout(() => btn.classList.remove('sidebar__entry--flash'), 1600);
        }
      });
    };
    window.addEventListener('suxai:reveal-in-sidebar', handler);
    return () => window.removeEventListener('suxai:reveal-in-sidebar', handler);
  }, [root]);

  const toggleDir = async (entry: TreeEntry) => {
    if (!entry.isDirectory) {
      onLeafOpen(entry);
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

  const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;

  return (
    <div className="sidebar__root-section">
      {showHeader ? (
        <button
          type="button"
          className="sidebar__root sidebar__root--collapsible"
          onClick={() => setCollapsed((c) => !c)}
          title={root}
        >
          <span
            className="sidebar__chev"
            aria-hidden
            style={{
              display: 'inline-flex',
              transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
              transition: 'transform var(--dur-quick) var(--ease-out-expo)',
            }}
          >
            <AtelierIcon name="i-chevron-right" size={10} />
          </span>
          <span className="sidebar__root-name">{rootName}</span>
        </button>
      ) : (
        <div className="sidebar__root" title={root}>
          <span className="sidebar__root-name">{rootName}</span>
        </div>
      )}
      {!collapsed && (
        loading ? (
          <div className="sidebar__empty"><span>Loading…</span></div>
        ) : (
          <TreeList
            entries={tree}
            depth={0}
            onToggle={toggleDir}
            activePath={activePath}
            gitStatus={gitStatus}
            onContextMenu={onContextMenu}
          />
        )
      )}
    </div>
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
              data-tree-path={e.path.replace(/\\/g, '/')}
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
