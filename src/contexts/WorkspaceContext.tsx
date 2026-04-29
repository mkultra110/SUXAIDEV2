import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { pushRecent } from '../lib/recent';
import { invalidateGitStatus } from '../lib/git';
import { snapshotFile } from '../lib/history';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty?: boolean;
  language?: string;
  pinned?: boolean;
  /** True for files created in-memory that haven't been saved to disk yet. */
  untitled?: boolean;
  /** v3.5 — line ending detected at read time. Drives the StatusBar
   *  EOL indicator and gets restored at write time. */
  eol?: 'LF' | 'CRLF';
  /** v3.5 — file encoding (currently UTF-8 ± BOM). */
  encoding?: 'UTF-8' | 'UTF-8 with BOM';
}

export interface PendingDiff {
  /** The file path this diff applies to. */
  path: string;
  /** Original content (usually the file's current content when diff opened). */
  original: string;
  /** Proposed content (from AI). */
  proposed: string;
  /** Short label shown in the diff toolbar (e.g. the model id or command). */
  label?: string;
  /**
   * Optional callback fired when the user resolves the diff (accept or
   * reject). Used by the agent loop to translate a hunk-by-hunk diff
   * decision back into a Promise<boolean> for executeTool's approve()
   * contract — when set, InlineDiff calls this with the materialised
   * final content on accept (or undefined on reject) so the caller
   * can persist (or skip) the change without going through openFile().
   */
  onResolve?: (accepted: boolean, finalContent?: string) => void;
}

interface WorkspaceState {
  /** v3.9 — primary alias of `workspaceRoots[0] ?? null`. Kept as a
   *  field on state so existing single-root consumers (sidebar git
   *  status, breadcrumb root, etc.) keep working without iteration. */
  workspaceRoot: string | null;
  /** v3.9 — multi-root list. Empty when no folder is open. The first
   *  entry is the « primary » root used by single-root call sites. */
  workspaceRoots: string[];
  openFiles: OpenFile[];
  activePath: string | null;
  selection: string;
  pendingDiff: PendingDiff | null;
  // v0.12.10: queue of diffs waiting for user decision. When the
  // agent loop emits N parallel edit_file / write_file calls, all
  // call openDiff() roughly simultaneously. Without a queue, only
  // the last one wins — the earlier ones' onResolve callbacks are
  // dropped and their tool_use sits in `running` forever, leaving
  // the "FILES MODIFIED · 1 pending" badge stuck on the chat panel.
  // The queue is FIFO; closeDiff/acceptDiff promote the next item.
  pendingDiffQueue: PendingDiff[];
}

/**
 * Rich snapshot of "what the user is currently looking at", consumed
 * by the AI panel to build the <additional_data> XML block injected
 * into every user message. Resolves demonstrative pronouns ("ce
 * script", "cette fonction", "la sélection") without the user having
 * to spell out the file path. Lives in a separate state slice so the
 * tracker can update it on every editor event without forcing a
 * cascade of re-renders through the whole workspace tree.
 */
export interface EditorContext {
  /** Active file path or null when nothing is open. */
  activeFilePath: string | null;
  /** 1-based cursor position (line, column). null when no editor. */
  cursorPosition: { line: number; column: number } | null;
  /** Active selection: line range + first 4 KB of text. null when empty. */
  selection: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    text: string;
  } | null;
  /** First visible viewport range (line numbers). */
  visibleRange: { startLine: number; endLine: number } | null;
  /** Last 5 edits across the workspace, newest first. */
  recentEdits: { path: string; line: number; ts: number }[];
  /** Last 10 distinct files the user focused, newest first. */
  recentlyViewedFiles: string[];
  /** Diagnostics for the active file (severity error/warning). */
  diagnostics: {
    path: string;
    severity: 'error' | 'warning' | 'info' | 'hint';
    message: string;
    line: number;
    column: number;
  }[];
}

const EMPTY_EDITOR_CONTEXT: EditorContext = {
  activeFilePath: null,
  cursorPosition: null,
  selection: null,
  visibleRange: null,
  recentEdits: [],
  recentlyViewedFiles: [],
  diagnostics: [],
};

export type SaveOutcome = 'saved' | 'unchanged' | 'cancelled' | 'error';

interface WorkspaceValue extends WorkspaceState {
  setWorkspaceRoot: (root: string | null) => void;
  /** v3.9 — set the entire roots list at once. Used by persisted
   *  restore + the « close all folders » command. */
  setWorkspaceRoots: (roots: string[]) => void;
  /** v3.9 — append `root` to the workspaceRoots if not already
   *  present. No-op if root is already in the list. */
  addWorkspaceRoot: (root: string) => void;
  /** v3.9 — remove `root` from the workspaceRoots. */
  removeWorkspaceRoot: (root: string) => void;
  openFile: (file: OpenFile) => void;
  closeFile: (path: string) => void;
  closeOthers: (keepPath: string) => void;
  closeToTheRight: (fromPath: string) => void;
  closeAll: () => void;
  setActive: (path: string) => void;
  updateActiveContent: (content: string) => void;
  setSelection: (text: string) => void;
  /** v2.1 — optional `transform` fn lets the caller (EditorPanel)
   *  inject Format-on-Save and Trim-trailing-whitespace BEFORE the
   *  bytes hit disk. The transform receives `(content, path)` and
   *  returns the modified content (or unchanged). Errors propagate. */
  saveActiveFile: (
    transform?: (content: string, path: string) => Promise<string> | string,
  ) => Promise<SaveOutcome>;
  /** v2.1 — Save All Dirty (Cmd+K S). Iterates over every dirty
   *  open file and saves it, applying the same `transform` callback
   *  to each. Returns counts so the caller can toast a summary
   *  («3 saved, 1 skipped, 0 failed»). Untitled files prompt
   *  Save-As one by one — caller can short-circuit by passing
   *  `skipUntitled: true`. */
  saveAllDirty: (
    transform?: (content: string, path: string) => Promise<string> | string,
    opts?: { skipUntitled?: boolean },
  ) => Promise<{ saved: number; skipped: number; failed: number }>;
  reloadActiveFromDisk: () => Promise<boolean>;
  newUntitled: () => void;
  /** v0.16.3 — reopen the most-recently-closed tab (Ctrl+Shift+T).
   *  Pops from a session-scoped stack capped at 20 entries.
   *  Returns the restored path, or null if the stack is empty / the
   *  file no longer exists on disk. */
  reopenLastClosed: () => Promise<string | null>;
  reorderTab: (fromPath: string, toPath: string) => void;
  togglePin: (path: string) => void;
  renameFile: (oldPath: string, newPath: string) => void;
  hasUnsaved: boolean;
  openDiff: (d: PendingDiff) => void;
  closeDiff: () => void;
  acceptDiff: () => void;
  // v0.12.10: number of diffs still queued behind the active one.
  // Surfaced to the UI so EditedFilesPanel can render "N more pending"
  // and so a Reject-all button knows there's something to drain.
  pendingDiffCount: number;
  /** v0.12.10: reject the active diff AND every diff in the queue
   *  whose path matches `predicate`. Each one's `onResolve(false)`
   *  fires so the agent loop resolves their promises. */
  rejectPendingDiffs: (predicate?: (d: PendingDiff) => boolean) => void;
  activeFile: OpenFile | null;
  /** Rich editor context — used by the AI panel. Never null; empty
   *  by default. Updated by `useEditorContextTracker(editor)`. */
  editorContext: EditorContext;
  /** Push a fresh snapshot. Called by the Monaco event tracker. Merges
   *  partial updates so callers can update only the slices they own. */
  updateEditorContext: (patch: Partial<EditorContext>) => void;
  /** Record a single edit for the recentEdits ring buffer. */
  recordEdit: (path: string, line: number) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    // Web
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'scss',
    less: 'less', vue: 'html', svelte: 'html',
    // Data
    json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
    ini: 'ini',
    // Systems
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', go: 'go', rs: 'rust',
    // JVM
    java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'java',
    // Apple
    swift: 'swift', m: 'objective-c', mm: 'objective-c',
    // Scripting
    py: 'python', pyi: 'python', rb: 'ruby', php: 'php',
    pl: 'perl', lua: 'lua', sh: 'shell', bash: 'shell', zsh: 'shell',
    fish: 'shell', ps1: 'powershell',
    // Functional
    hs: 'haskell', clj: 'clojure', cljs: 'clojure', ex: 'elixir', exs: 'elixir',
    // Mobile
    dart: 'dart',
    // DB / query
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    // DevOps
    dockerfile: 'dockerfile', tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
    // Data science
    r: 'r', jl: 'julia',
  };

  // Filename-based fallbacks (no extension or special names).
  const name = p.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile' || name.endsWith('.mk') || name.endsWith('.mak')) return 'shell';
  if (name === '.gitignore' || name === '.dockerignore' || name === '.npmignore') return 'plaintext';
  if (name === '.editorconfig' || name.startsWith('.env')) return 'ini';
  if (name === 'cmakelists.txt' || name.endsWith('.cmake')) return 'cmake';
  if (name === '.bashrc' || name === '.zshrc' || name === '.profile') return 'shell';

  return map[ext] ?? 'plaintext';
}

const PERSIST_KEY = 'suxai.workspace.v1';

interface PersistedWorkspace {
  /** v3.9 — multi-root persisted shape. Older sessions wrote the
   *  legacy `workspaceRoot` only ; we still read both for forward
   *  compat. New writes always include both fields with `roots[0]`
   *  mirrored into `workspaceRoot`. */
  workspaceRoot: string | null;
  workspaceRoots?: string[];
  openPaths: string[];
  activePath: string | null;
}

function loadPersisted(): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(state: PersistedWorkspace): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
  } catch {
    /* quota etc. — ignore */
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>({
    workspaceRoot: null,
    workspaceRoots: [],
    openFiles: [],
    activePath: null,
    selection: '',
    pendingDiff: null,
    pendingDiffQueue: [],
  });
  const [restored, setRestored] = useState(false);
  // Rich editor context lives in its own slice — updated on every
  // cursor move / selection change / scroll, which would otherwise
  // re-render every consumer of WorkspaceState. The AI panel is the
  // only real consumer; everyone else can ignore this slice via
  // useEditorContext() instead of useWorkspace().
  const [editorContext, setEditorContext] = useState<EditorContext>(EMPTY_EDITOR_CONTEXT);
  const updateEditorContext = useCallback((patch: Partial<EditorContext>) => {
    setEditorContext((prev) => {
      const next = { ...prev, ...patch };
      // Maintain the recentlyViewedFiles ring buffer when the active
      // file actually changes — without this, switching tabs back and
      // forth wouldn't update the list at all.
      if (
        patch.activeFilePath &&
        patch.activeFilePath !== prev.activeFilePath
      ) {
        const filtered = prev.recentlyViewedFiles.filter(
          (p) => p !== patch.activeFilePath,
        );
        next.recentlyViewedFiles = [patch.activeFilePath, ...filtered].slice(0, 10);
      }
      return next;
    });
  }, []);
  const recordEdit = useCallback((path: string, line: number) => {
    setEditorContext((prev) => {
      const filtered = prev.recentEdits.filter(
        (e) => !(e.path === path && Math.abs(e.line - line) <= 2),
      );
      return {
        ...prev,
        recentEdits: [{ path, line, ts: Date.now() }, ...filtered].slice(0, 5),
      };
    });
  }, []);

  // v3.9 — multi-root setters. `setWorkspaceRoot` is preserved for
  // back-compat (replaces the entire list with [root] or []). The
  // canonical truth is `workspaceRoots` ; `workspaceRoot` is mirrored
  // to `roots[0] ?? null` so existing consumers keep working without
  // touching them.
  const setWorkspaceRoots = useCallback((roots: string[]) => {
    // Dedupe + drop empties + normalise (no trailing slash) so that
    // toggling a root back and forth doesn't duplicate it.
    const seen = new Set<string>();
    const normed: string[] = [];
    for (const r of roots) {
      if (typeof r !== 'string' || r.length === 0) continue;
      const norm = r.replace(/[\\/]+$/, '');
      if (seen.has(norm)) continue;
      seen.add(norm);
      normed.push(norm);
    }
    setState((s) => ({
      ...s,
      workspaceRoots: normed,
      workspaceRoot: normed[0] ?? null,
    }));
  }, []);

  const setWorkspaceRoot = useCallback((root: string | null) => {
    setWorkspaceRoots(root ? [root] : []);
  }, [setWorkspaceRoots]);

  const addWorkspaceRoot = useCallback((root: string) => {
    if (typeof root !== 'string' || root.length === 0) return;
    const norm = root.replace(/[\\/]+$/, '');
    setState((s) => {
      if (s.workspaceRoots.includes(norm)) return s;
      const nextRoots = [...s.workspaceRoots, norm];
      return {
        ...s,
        workspaceRoots: nextRoots,
        workspaceRoot: nextRoots[0] ?? null,
      };
    });
  }, []);

  const removeWorkspaceRoot = useCallback((root: string) => {
    const norm = root.replace(/[\\/]+$/, '');
    setState((s) => {
      const nextRoots = s.workspaceRoots.filter((r) => r !== norm);
      if (nextRoots.length === s.workspaceRoots.length) return s;
      return {
        ...s,
        workspaceRoots: nextRoots,
        workspaceRoot: nextRoots[0] ?? null,
      };
    });
  }, []);

  // Restore last session on first mount.
  useEffect(() => {
    if (restored) return;
    const persisted = loadPersisted();
    if (!persisted) {
      setRestored(true);
      return;
    }
    (async () => {
      try {
        // v3.9 — restore the multi-root list. Older sessions only
        // wrote `workspaceRoot` (singleton) ; we coerce that to a
        // single-element list. New sessions write `workspaceRoots`
        // explicitly.
        const restoredRoots: string[] = (() => {
          if (Array.isArray(persisted.workspaceRoots) && persisted.workspaceRoots.length > 0) {
            return persisted.workspaceRoots.filter((r): r is string => typeof r === 'string');
          }
          if (persisted.workspaceRoot) return [persisted.workspaceRoot];
          return [];
        })();
        if (restoredRoots.length > 0) {
          setWorkspaceRoots(restoredRoots);
        }
        const files: OpenFile[] = [];
        for (const p of persisted.openPaths ?? []) {
          try {
            const f = await window.suxai.fs.readFile(p);
            const name = p.split(/[\\/]/).pop() ?? p;
            files.push({
              path: f.path,
              name,
              content: f.content,
              language: langFromPath(f.path),
            });
          } catch {
            /* file moved/deleted since last session — skip silently */
          }
        }
        if (files.length > 0) {
          const active =
            persisted.activePath && files.some((f) => f.path === persisted.activePath)
              ? persisted.activePath
              : files[0].path;
          setState((s) => ({ ...s, openFiles: files, activePath: active }));
        }
      } finally {
        setRestored(true);
      }
    })();
  }, [restored]);

  // Persist on change. Keyed off a cheap fingerprint ('path1|path2||active')
  // so content edits, selection moves, and dirty-flag toggles don't
  // thrash localStorage. Untitled buffers are excluded from the saved
  // list so we don't try to read a virtual `untitled://N` path on next
  // launch.
  const persistedFingerprint = useMemo(() => {
    const paths = state.openFiles
      .filter((f) => !f.untitled && !f.path.startsWith('untitled://'))
      .map((f) => f.path);
    // v3.9 — fingerprint includes the full roots list so adding/removing
    // a folder triggers a savePersisted. The legacy `workspaceRoot` field
    // is mirrored from `roots[0]` so we don't double-count it.
    const rootsKey = state.workspaceRoots.join('|');
    return `${rootsKey}||${paths.join('|')}||${state.activePath ?? ''}`;
  }, [state.workspaceRoots, state.openFiles, state.activePath]);

  // v3.5 (A8) — sync openFiles[*].eol when StatusBar toggles via
  // fs:set-eol. The IPC has already updated the main-process record ;
  // we mirror it locally so the StatusBar pill flips immediately.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path: string; eol: 'LF' | 'CRLF' }>).detail;
      if (!detail) return;
      setState((s) => ({
        ...s,
        openFiles: s.openFiles.map((f) =>
          f.path === detail.path ? { ...f, eol: detail.eol, dirty: true } : f,
        ),
      }));
    };
    window.addEventListener('suxai:eol-changed', handler);
    return () => window.removeEventListener('suxai:eol-changed', handler);
  }, []);

  useEffect(() => {
    if (!restored) return;
    const [rootsKey = '', pathStr = '', active = ''] = persistedFingerprint.split('||');
    const roots = rootsKey ? rootsKey.split('|').filter(Boolean) : [];
    savePersisted({
      // v3.9 — write both shapes : the new `workspaceRoots[]` is the
      // canonical truth ; `workspaceRoot` is mirrored to the primary
      // root so a downgrade to V3.8 (which only reads `workspaceRoot`)
      // still loads the user's main folder.
      workspaceRoot: roots[0] ?? null,
      workspaceRoots: roots,
      openPaths: pathStr ? pathStr.split('|') : [],
      activePath: active || null,
    });
  }, [restored, persistedFingerprint]);

  const openFile = useCallback((file: OpenFile) => {
    setState((s) => {
      const language = file.language ?? langFromPath(file.path);
      const existingIdx = s.openFiles.findIndex((f) => f.path === file.path);
      const next = [...s.openFiles];
      if (existingIdx >= 0) next[existingIdx] = { ...next[existingIdx], ...file, language };
      else next.push({ ...file, language });
      // v0.13.15 — record disk-backed opens in the global Recent list.
      // pushRecent is a no-op for untitled:// paths, so we don't need
      // to filter here. Read workspaceRoot from the in-flight state
      // since this runs inside the setter.
      pushRecent({ path: file.path, name: file.name, workspace: s.workspaceRoot ?? undefined });
      return { ...s, openFiles: next, activePath: file.path };
    });
  }, []);

  const closeFile = useCallback((path: string) => {
    // Guard against silently discarding unsaved changes — for both
    // disk-backed dirty files and untitled buffers with content.
    // window.confirm is synchronous + blocking so it must stay
    // outside setState (which has to be pure under Strict Mode).
    const target = stateRef.current.openFiles.find((f) => f.path === path);
    if (target) {
      const hasContent = target.untitled
        ? target.content.length > 0
        : !!target.dirty;
      if (hasContent) {
        const ok = window.confirm(
          target.untitled
            ? `Close "${target.name}"? It hasn't been saved to disk yet.`
            : `Close "${target.name}" with unsaved changes?`,
        );
        if (!ok) return;
      }
      // v0.16.3 — push to the closed-tab stack BEFORE the setState
      // updater so reopenLastClosed can pull a fresh entry. Untitled
      // buffers are intentionally not stacked : they have no path to
      // restore and re-creating them would just spawn an empty buffer.
      if (!target.untitled) {
        closedStackRef.current.push({
          path: target.path,
          name: target.name,
          ts: Date.now(),
        });
        // Cap at 20 most recent — VSCode default behaviour.
        if (closedStackRef.current.length > 20) {
          closedStackRef.current.splice(0, closedStackRef.current.length - 20);
        }
      }
    }
    // v0.15.11 (audit-5 #4) — re-validate the path still exists at
    // the time of the actual update. Between the confirm() and the
    // setState callback, the user could have closed the same tab via
    // another path (Ctrl+W, drag-drop replacement, etc.) — bail
    // cleanly if the tab vanished. This also makes the activePath
    // recomputation atomic with the filter step.
    setState((s) => {
      const idx = s.openFiles.findIndex((f) => f.path === path);
      if (idx < 0) return s;
      const filtered = s.openFiles.filter((f) => f.path !== path);
      let nextActive = s.activePath;
      if (s.activePath === path) {
        nextActive = filtered[idx]?.path ?? filtered[idx - 1]?.path ?? filtered[0]?.path ?? null;
      }
      return { ...s, openFiles: filtered, activePath: nextActive };
    });
  }, []);

  const setActive = useCallback((path: string) => {
    setState((s) => ({ ...s, activePath: path }));
  }, []);

  const updateActiveContent = useCallback((content: string) => {
    setState((s) => {
      if (!s.activePath) return s;
      let changed = false;
      const next = s.openFiles.map((f) => {
        if (f.path !== s.activePath) return f;
        if (f.content === content) return f; // exact same buffer — no-op
        changed = true;
        return { ...f, content, dirty: true };
      });
      return changed ? { ...s, openFiles: next } : s;
    });
  }, []);

  const setSelection = useCallback((text: string) => {
    setState((s) => ({ ...s, selection: text }));
  }, []);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // v0.16.3 — session-scoped closed-tab stack. Each closeFile push
  // appends the closed file's metadata ; reopenLastClosed pops the
  // tail and re-reads the file from disk. Ref-only (not state) so
  // the stack mutation doesn't trigger re-renders of consumers that
  // don't care.
  interface ClosedTabEntry { path: string; name: string; ts: number }
  const closedStackRef = useRef<ClosedTabEntry[]>([]);

  const reopenLastClosed = useCallback(async (): Promise<string | null> => {
    while (closedStackRef.current.length > 0) {
      const entry = closedStackRef.current.pop();
      if (!entry) break;
      // Skip if the tab is already open (can happen if the user
      // re-opened the file via Quick Open between close + reopen).
      if (stateRef.current.openFiles.some((f) => f.path === entry.path)) continue;
      try {
        const file = await window.suxai.fs.readFile(entry.path);
        // openFile re-establishes language detection + recent push.
        setState((s) => {
          const next = [...s.openFiles];
          next.push({
            path: file.path,
            name: entry.name,
            content: file.content,
            language: langFromPath(file.path),
          });
          return { ...s, openFiles: next, activePath: file.path };
        });
        return entry.path;
      } catch {
        // File deleted / moved / permission denied — drop it and try
        // the next entry on the stack.
        continue;
      }
    }
    return null;
  }, []);

  /** v2.1 — internal helper used by saveActiveFile + saveAllDirty.
   *  Applies the optional transform, writes to disk, refreshes git +
   *  history, updates state. Single source of truth for the write
   *  pipeline so format-on-save / trim-on-save behaves identically
   *  whether the user hit Cmd+S or Cmd+K S. */
  const persistOne = useCallback(
    async (
      file: { path: string; content: string; dirty?: boolean; untitled?: boolean; name?: string },
      transform?: (content: string, path: string) => Promise<string> | string,
    ): Promise<SaveOutcome> => {
      let targetPath = file.path;
      let alreadyWritten = false;
      let bytes = file.content;

      if (file.untitled) {
        try {
          const picked = await window.suxai.fs.saveAs?.(file.content, file.name ?? 'Untitled');
          if (!picked) return 'cancelled';
          targetPath = picked;
          alreadyWritten = true;
        } catch (err) {
          console.error('[save-as] failed:', err);
          return 'error';
        }
      } else if (!file.dirty) {
        return 'unchanged';
      }

      // v2.1 — run the transform AFTER Save-As resolved (so the
      // transform sees the right path for language detection) but
      // BEFORE the actual write. If the transform mutated the bytes
      // and Save-As already wrote the un-transformed version, we
      // re-write with the transformed bytes. Cheap; matches what
      // VSCode does with formatOnSave + a freshly-named file.
      if (transform) {
        try {
          const out = await transform(bytes, targetPath);
          if (typeof out === 'string') bytes = out;
        } catch (err) {
          console.warn('[save-transform] failed, writing un-transformed bytes:', err);
        }
      }

      try {
        if (!alreadyWritten || bytes !== file.content) {
          await window.suxai.fs.writeFile(targetPath, bytes);
        }
        const ws = stateRef.current.workspaceRoot;
        if (ws) invalidateGitStatus(ws);
        void snapshotFile(targetPath, bytes);
        setState((prev) => {
          const stillOpen = prev.openFiles.some((f) => f.path === file.path);
          if (!stillOpen) return prev;
          return {
            ...prev,
            openFiles: prev.openFiles.map((f) =>
              f.path === file.path
                ? {
                    ...f,
                    path: targetPath,
                    name: targetPath.split(/[\\/]/).pop() ?? f.name ?? '',
                    content: bytes,
                    dirty: false,
                    untitled: false,
                    language: langFromPath(targetPath),
                  }
                : f,
            ),
            activePath: prev.activePath === file.path ? targetPath : prev.activePath,
          };
        });
        return 'saved';
      } catch (err) {
        console.error('Failed to save file:', err);
        return 'error';
      }
    },
    [],
  );

  const saveActiveFile = useCallback(async (
    transform?: (content: string, path: string) => Promise<string> | string,
  ): Promise<SaveOutcome> => {
    const s = stateRef.current;
    const toSave = s.openFiles.find((f) => f.path === s.activePath);
    if (!toSave) return 'unchanged';
    return persistOne(toSave, transform);
  }, [persistOne]);

  const saveAllDirty = useCallback(async (
    transform?: (content: string, path: string) => Promise<string> | string,
    opts?: { skipUntitled?: boolean },
  ): Promise<{ saved: number; skipped: number; failed: number }> => {
    const s = stateRef.current;
    const targets = s.openFiles.filter((f) =>
      f.dirty || (f.untitled && !opts?.skipUntitled),
    );
    let saved = 0;
    let skipped = 0;
    let failed = 0;
    for (const f of targets) {
      const res = await persistOne(f, transform);
      if (res === 'saved') saved++;
      else if (res === 'cancelled' || res === 'unchanged') skipped++;
      else failed++;
    }
    return { saved, skipped, failed };
  }, [persistOne]);

  // Re-read the active file from disk. Used on window-focus to catch
  // external changes made while SUXAI was unfocused. Bails if the file
  // has unsaved local changes — we never silently overwrite the user's
  // in-memory edits.
  const reloadActiveFromDisk = useCallback(async (): Promise<boolean> => {
    const s = stateRef.current;
    const target = s.openFiles.find((f) => f.path === s.activePath);
    if (!target) return false;
    if (target.untitled) return false; // no on-disk source
    if (target.dirty) return false; // don't trample local edits
    try {
      const fresh = await window.suxai.fs.readFile(target.path);
      if (fresh.content === target.content) return false; // no change
      setState((prev) => ({
        ...prev,
        openFiles: prev.openFiles.map((f) =>
          f.path === target.path ? { ...f, content: fresh.content } : f,
        ),
      }));
      return true;
    } catch {
      // file may have been deleted since — leave the buffer alone
      return false;
    }
  }, []);

  const closeOthers = useCallback((keepPath: string) => {
    setState((s) => {
      const filtered = s.openFiles.filter((f) => f.path === keepPath || f.pinned);
      return {
        ...s,
        openFiles: filtered,
        activePath: filtered.some((f) => f.path === keepPath) ? keepPath : filtered[0]?.path ?? null,
      };
    });
  }, []);

  const closeToTheRight = useCallback((fromPath: string) => {
    setState((s) => {
      const idx = s.openFiles.findIndex((f) => f.path === fromPath);
      if (idx < 0) return s;
      const kept = s.openFiles.filter((f, i) => i <= idx || f.pinned);
      return {
        ...s,
        openFiles: kept,
        activePath: kept.some((f) => f.path === s.activePath)
          ? s.activePath
          : fromPath,
      };
    });
  }, []);

  const closeAll = useCallback(() => {
    setState((s) => {
      const kept = s.openFiles.filter((f) => f.pinned);
      return {
        ...s,
        openFiles: kept,
        activePath: kept[0]?.path ?? null,
      };
    });
  }, []);

  const newUntitled = useCallback(() => {
    setState((s) => {
      let i = 1;
      // Keep incrementing until the name is free.
      while (s.openFiles.some((f) => f.path === `untitled://${i}`)) i++;
      const virtualPath = `untitled://${i}`;
      const entry: OpenFile = {
        path: virtualPath,
        name: `Untitled-${i}`,
        content: '',
        dirty: true,
        untitled: true,
        language: 'plaintext',
      };
      return { ...s, openFiles: [...s.openFiles, entry], activePath: virtualPath };
    });
  }, []);

  const reorderTab = useCallback((fromPath: string, toPath: string) => {
    setState((s) => {
      const from = s.openFiles.findIndex((f) => f.path === fromPath);
      const to = s.openFiles.findIndex((f) => f.path === toPath);
      if (from < 0 || to < 0 || from === to) return s;
      const next = s.openFiles.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...s, openFiles: next };
    });
  }, []);

  const togglePin = useCallback((path: string) => {
    setState((s) => ({
      ...s,
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, pinned: !f.pinned } : f)),
    }));
  }, []);

  const renameFile = useCallback((oldPath: string, newPath: string) => {
    setState((s) => {
      // If the destination is already open, drop the stale tab first so
      // we don't end up with two entries pointing at the same path.
      const withoutDest = s.openFiles.filter((f) => f.path !== newPath || f.path === oldPath);
      return {
        ...s,
        openFiles: withoutDest.map((f) =>
          f.path === oldPath
            ? {
                ...f,
                path: newPath,
                name: newPath.split(/[\\/]/).pop() ?? f.name,
                language: langFromPath(newPath),
              }
            : f,
        ),
        activePath: s.activePath === oldPath ? newPath : s.activePath,
      };
    });
  }, []);

  // v0.12.10: openDiff queues if there's already an active diff so
  // parallel edit_file calls don't clobber each other. The user
  // resolves them one at a time, promoting from the queue.
  // v0.16.4 — CRITICAL FIX : also ensure the diff's file is in
  // openFiles AND becomes the active tab. Without this, the agent
  // could call edit_file on a file the user didn't have focused
  // (or didn't have open at all) — openDiff would set pendingDiff,
  // but EditorPanel's v0.12.13 visibility gate
  //   `pendingDiff && activeFile?.path === pendingDiff.path`
  // would hide the InlineDiff overlay. The user would see "agent
  // does read_file but never modifies anything" while the agent
  // sits forever waiting for an approval that never reaches the UI.
  const openDiff = useCallback((d: PendingDiff) => {
    setState((s) => {
      // Ensure the file is open. If the agent edits a file not yet
      // in the tab strip, we open it using `original` as initial
      // content so the user has a real buffer to compare against.
      let openFiles = s.openFiles;
      if (!openFiles.some((f) => f.path === d.path)) {
        const fileName = d.path.split(/[\\/]/).pop() ?? d.path;
        openFiles = [
          ...openFiles,
          {
            path: d.path,
            name: fileName,
            content: d.original,
            language: langFromPath(d.path),
          },
        ];
      }
      // No current diff → show this one and focus its file.
      if (!s.pendingDiff) {
        return {
          ...s,
          openFiles,
          activePath: d.path,
          pendingDiff: d,
        };
      }
      // A diff is already showing → queue without disturbing focus
      // (the user is mid-review, don't yank the editor out from
      // under them). The queued diff will gain focus when promoted.
      return {
        ...s,
        openFiles,
        pendingDiffQueue: [...s.pendingDiffQueue, d],
      };
    });
  }, []);

  const closeDiff = useCallback(() => {
    setState((s) => {
      const [next, ...rest] = s.pendingDiffQueue;
      return {
        ...s,
        pendingDiff: next ?? null,
        pendingDiffQueue: rest,
        // v0.16.4 — when promoting the next queued diff, follow it to
        // its file so the InlineDiff stays visible. If queue is empty,
        // leave activePath as-is.
        activePath: next ? next.path : s.activePath,
      };
    });
  }, []);

  const acceptDiff = useCallback(() => {
    // v0.15.5 (audit #4) — read the workspaceRoot OUTSIDE the setState
    // updater. Side-effects inside setState callbacks fire twice under
    // React 18 Strict Mode and can race with subsequent renders.
    const ws = stateRef.current.workspaceRoot;
    setState((s) => {
      const d = s.pendingDiff;
      if (!d) return s;
      const nextOpenFiles = s.openFiles.map((f) =>
        f.path === d.path ? { ...f, content: d.proposed, dirty: true } : f,
      );
      const [nextDiff, ...rest] = s.pendingDiffQueue;
      return {
        ...s,
        openFiles: nextOpenFiles,
        pendingDiff: nextDiff ?? null,
        pendingDiffQueue: rest,
        // v0.16.4 — follow the queue : if there's a next diff, switch
        // to its file so the InlineDiff overlay stays visible. Without
        // this, accepting a diff for FileA with FileB queued left the
        // tab on FileA and FileB's diff was hidden by EditorPanel's
        // path-match gate.
        activePath: nextDiff ? nextDiff.path : d.path,
      };
    });
    // Refresh badges in case the agent already wrote the file via
    // skipMtimeCheck. Pure call here, no Strict-Mode hazard.
    if (ws) invalidateGitStatus(ws);
  }, []);

  // v0.12.10: bulk-reject diffs matching a predicate. Each matched
  // diff's `onResolve(false)` fires synchronously so the agent loop's
  // approve() promises settle and the tool_use snapshots flip from
  // 'pending' → 'rejected'. Without a predicate, drains everything
  // (active + queue).
  const rejectPendingDiffs = useCallback(
    (predicate?: (d: PendingDiff) => boolean) => {
      const match = predicate ?? (() => true);
      setState((s) => {
        const active = s.pendingDiff;
        const queue = s.pendingDiffQueue;
        // Build the list of diffs to reject and what to keep.
        const toReject: PendingDiff[] = [];
        const keptQueue: PendingDiff[] = [];
        if (active && match(active)) toReject.push(active);
        for (const d of queue) (match(d) ? toReject : keptQueue).push(d);
        // Fire onResolve(false) on each. Done outside the setState
        // closure semantically, but synchronous resolution is fine
        // because React batches anyway.
        for (const d of toReject) {
          try { d.onResolve?.(false); } catch { /* */ }
        }
        // If the active diff was rejected, promote the next non-
        // rejected from the original queue (already in keptQueue
        // order), otherwise keep the active intact.
        const stillActive = active && !match(active) ? active : null;
        if (stillActive) {
          return { ...s, pendingDiffQueue: keptQueue };
        }
        const [nextActive, ...restQueue] = keptQueue;
        return {
          ...s,
          pendingDiff: nextActive ?? null,
          pendingDiffQueue: restQueue,
        };
      });
    },
    [],
  );

  const activeFile = useMemo(
    () => state.openFiles.find((f) => f.path === state.activePath) ?? null,
    [state.openFiles, state.activePath],
  );

  const hasUnsaved = useMemo(
    () => state.openFiles.some((f) => f.dirty && !f.untitled),
    [state.openFiles],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      ...state,
      activeFile,
      hasUnsaved,
      setWorkspaceRoot,
      setWorkspaceRoots,
      addWorkspaceRoot,
      removeWorkspaceRoot,
      openFile,
      closeFile,
      closeOthers,
      closeToTheRight,
      closeAll,
      setActive,
      updateActiveContent,
      setSelection,
      saveActiveFile,
      saveAllDirty,
      reloadActiveFromDisk,
      newUntitled,
      reopenLastClosed,
      reorderTab,
      togglePin,
      renameFile,
      openDiff,
      closeDiff,
      acceptDiff,
      pendingDiffCount: state.pendingDiffQueue.length + (state.pendingDiff ? 1 : 0),
      rejectPendingDiffs,
      editorContext,
      updateEditorContext,
      recordEdit,
    }),
    [
      state, activeFile, hasUnsaved,
      setWorkspaceRoot, setWorkspaceRoots, addWorkspaceRoot, removeWorkspaceRoot,
      openFile, closeFile,
      closeOthers, closeToTheRight, closeAll, setActive, rejectPendingDiffs,
      updateActiveContent, setSelection, saveActiveFile, saveAllDirty, reloadActiveFromDisk, newUntitled,
      reopenLastClosed, reorderTab,
      togglePin, renameFile, openDiff, closeDiff, acceptDiff,
      editorContext, updateEditorContext, recordEdit,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return ctx;
}
