/**
 * Aider-style repo map. Walks the workspace, extracts top-level
 * symbol declarations + import references per file via per-language
 * regex (no tree-sitter — keeps the bundle small), runs Personalized
 * PageRank to rank files by their structural importance, and emits
 * a compact text "map" of the highest-ranked files showing only
 * their signatures. Injected into the agent's first user message
 * so the model has a structural overview of the codebase without
 * us having to dump every file.
 *
 * Cap: budget 1024 tokens (~4 KB) of output by default. Anything
 * over that gets dropped from the bottom of the ranking.
 *
 * Cached in localStorage keyed by workspaceRoot — second + nth
 * invocation in the same session is instant.
 */

interface SymbolDef {
  name: string;
  /** Single-line signature without bodies (kept short — joined by "; "). */
  signature: string;
  kind: 'function' | 'class' | 'struct' | 'type' | 'method' | 'const' | 'enum';
}

interface FileEntry {
  path: string;
  language: string;
  defs: SymbolDef[];
  refs: string[]; // module names / paths referenced by import/include
  size: number;
}

const NOISY_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron',
  'build', 'release', '.next', '.cache', '.turbo', '.parcel-cache',
  '.idea', '.vscode', 'coverage', '__pycache__', '.venv', 'venv',
  'target', 'vendor', 'bower_components',
]);

const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'scala', 'swift',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx',
  'cs', 'fs', 'm', 'mm',
  'lua', 'pl', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'gql',
  'json', 'yaml', 'yml', 'toml',
]);

const MAX_FILES = 800;
const MAX_FILE_BYTES = 600_000;
const MAX_CHILDREN_PER_DIR = 200;
const MAX_DEFS_PER_FILE = 60;

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

async function listFilesRecursive(
  root: string,
  /** Caller's IPC reader (window.suxai.fs.readDir). Injected for
   *  testability — we don't import window directly here. */
  readDir: (p: string) => Promise<DirEntry[]>,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= MAX_FILES) return;
    if (depth > 12) return; // pathologically deep tree — bail
    let entries: DirEntry[];
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    if (entries.length > MAX_CHILDREN_PER_DIR) {
      entries = entries.slice(0, MAX_CHILDREN_PER_DIR);
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (NOISY_DIRS.has(e.name)) continue;
      if (e.isDirectory) {
        await walk(e.path, depth + 1);
      } else {
        const ext = e.name.includes('.') ? e.name.split('.').pop()!.toLowerCase() : '';
        if (TEXT_EXTENSIONS.has(ext)) out.push(e.path);
      }
    }
  }
  await walk(root, 0);
  return out;
}

function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'py' || ext === 'pyi') return 'python';
  if (ext === 'rb') return 'ruby';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  if (['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx'].includes(ext)) return 'cpp';
  if (ext === 'java') return 'java';
  if (ext === 'kt' || ext === 'kts') return 'kotlin';
  if (ext === 'cs') return 'csharp';
  return 'plaintext';
}

/**
 * Per-language regex extractors. Each entry returns the list of
 * top-level definitions found in the file content. Kept lossy on
 * purpose: we only want enough to rank files and render signatures.
 * False positives (e.g. a string literal that looks like a function
 * declaration) are tolerable because PageRank smooths them out.
 */
function extractDefs(content: string, language: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const lines = content.split('\n');
  const push = (kind: SymbolDef['kind'], name: string, signature: string) => {
    if (defs.length >= MAX_DEFS_PER_FILE) return;
    defs.push({ kind, name, signature: signature.slice(0, 200) });
  };

  if (language === 'typescript' || language === 'javascript') {
    for (const raw of lines) {
      const line = raw.trim();
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\*\s*)?(\w+)/))) {
        push('function', m[2], line.replace(/\s*\{.*$/, ''));
      } else if ((m = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/))) {
        push('class', m[1], line.replace(/\s*\{.*$/, ''));
      } else if ((m = line.match(/^(?:export\s+)?interface\s+(\w+)/))) {
        push('type', m[1], line.replace(/\s*\{.*$/, ''));
      } else if ((m = line.match(/^(?:export\s+)?type\s+(\w+)\s*=/))) {
        push('type', m[1], line);
      } else if ((m = line.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/))) {
        push('const', m[1], line);
      } else if ((m = line.match(/^(?:export\s+)?enum\s+(\w+)/))) {
        push('enum', m[1], line.replace(/\s*\{.*$/, ''));
      }
    }
  } else if (language === 'python') {
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^(\s*)def\s+(\w+)/))) {
        const isTopLevel = m[1].length === 0;
        const isMethod = m[1].length > 0;
        push(isMethod ? 'method' : 'function', m[2], line.trim());
        if (!isTopLevel && !isMethod) continue;
      } else if ((m = line.match(/^class\s+(\w+)/))) {
        push('class', m[1], line.trim());
      }
    }
  } else if (language === 'cpp' || language === 'c') {
    for (const raw of lines) {
      const line = raw.trim();
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^class\s+(\w+)/))) {
        push('class', m[1], line.replace(/\s*\{.*$/, '').replace(/\s*;\s*$/, ''));
      } else if ((m = line.match(/^struct\s+(\w+)/))) {
        push('struct', m[1], line.replace(/\s*\{.*$/, '').replace(/\s*;\s*$/, ''));
      } else if ((m = line.match(/^(?:[A-Z]\w*::|[\w<>:&*\s]+\s+)(\w+)\s*\([^)]*\)\s*(?:const)?\s*[\{;]/))) {
        push('function', m[1], line.replace(/\s*\{.*$/, '').replace(/\s*;\s*$/, ''));
      }
    }
  } else if (language === 'go') {
    for (const raw of lines) {
      const line = raw.trim();
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^func(?:\s+\([^)]+\))?\s+(\w+)/))) {
        push('function', m[1], line.replace(/\s*\{.*$/, ''));
      } else if ((m = line.match(/^type\s+(\w+)\s+(struct|interface)/))) {
        push(m[2] === 'struct' ? 'struct' : 'type', m[1], line.replace(/\s*\{.*$/, ''));
      }
    }
  } else if (language === 'rust') {
    for (const raw of lines) {
      const line = raw.trim();
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/))) {
        push('function', m[1], line.replace(/\s*\{.*$/, ''));
      } else if ((m = line.match(/^(?:pub\s+)?struct\s+(\w+)/))) {
        push('struct', m[1], line.replace(/\s*[\{;].*$/, ''));
      } else if ((m = line.match(/^(?:pub\s+)?enum\s+(\w+)/))) {
        push('enum', m[1], line.replace(/\s*\{.*$/, ''));
      }
    }
  } else if (language === 'java' || language === 'kotlin' || language === 'csharp') {
    for (const raw of lines) {
      const line = raw.trim();
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^(?:public|private|protected|internal|fun)?\s*(?:static\s+)?(?:final\s+)?\w[\w<>]*\s+(\w+)\s*\(/))) {
        push('function', m[1], line.replace(/\s*\{.*$/, '').replace(/\s*;\s*$/, ''));
      } else if ((m = line.match(/^(?:public\s+)?class\s+(\w+)/))) {
        push('class', m[1], line.replace(/\s*\{.*$/, ''));
      }
    }
  }
  return defs;
}

/** Module-name references via import/include syntax. */
function extractRefs(content: string, language: string): string[] {
  const refs = new Set<string>();
  if (language === 'typescript' || language === 'javascript') {
    const re = /(?:import\s.+?from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content))) refs.add(m[1]);
  } else if (language === 'python') {
    const re = /^\s*(?:from\s+([\w.]+)|import\s+([\w.]+))/gm;
    let m;
    while ((m = re.exec(content))) refs.add(m[1] ?? m[2]);
  } else if (language === 'cpp' || language === 'c') {
    const re = /#include\s*[<"]([^>"]+)[>"]/g;
    let m;
    while ((m = re.exec(content))) refs.add(m[1]);
  } else if (language === 'go') {
    const re = /import\s*(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g;
    let m;
    while ((m = re.exec(content))) {
      if (m[2]) refs.add(m[2]);
      if (m[1]) {
        const inner = /"([^"]+)"/g;
        let n;
        while ((n = inner.exec(m[1]))) refs.add(n[1]);
      }
    }
  } else if (language === 'rust') {
    const re = /^\s*use\s+([\w:]+)/gm;
    let m;
    while ((m = re.exec(content))) refs.add(m[1].split('::')[0]);
  } else if (language === 'java' || language === 'kotlin') {
    const re = /^\s*import\s+([\w.]+)\s*;?/gm;
    let m;
    while ((m = re.exec(content))) refs.add(m[1]);
  }
  return [...refs];
}

/**
 * Score each file via Personalized PageRank. Boost: open files
 * (×10), active file (×30), recently viewed (×3). Damping 0.85,
 * 25 iterations of power method — converges enough for a
 * lightweight ranking.
 */
function pageRank(
  files: FileEntry[],
  boost: { activeFilePath?: string | null; openPaths?: string[]; recentPaths?: string[] },
): Map<string, number> {
  const N = files.length;
  if (N === 0) return new Map();

  // Build edges from refs → files. Resolve each ref to a candidate
  // file by basename match (cheap heuristic, works for both
  // `from './foo'` and `#include "foo.h"`).
  const byName = new Map<string, FileEntry[]>();
  for (const f of files) {
    const base = f.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base)!.push(f);
  }
  const adj = new Map<string, string[]>();
  for (const f of files) adj.set(f.path, []);
  for (const f of files) {
    for (const ref of f.refs) {
      const base = ref.replace(/\.[^.]+$/, '').split(/[\\/]/).pop()!;
      const candidates = byName.get(base);
      if (!candidates) continue;
      for (const c of candidates) {
        if (c.path !== f.path) adj.get(f.path)!.push(c.path);
      }
    }
  }

  // Personalization vector.
  const personalization = new Map<string, number>();
  let totalBias = 0;
  for (const f of files) {
    let bias = 1;
    if (boost.openPaths?.includes(f.path)) bias += 9;
    if (boost.recentPaths?.includes(f.path)) bias += 2;
    if (boost.activeFilePath === f.path) bias += 30;
    personalization.set(f.path, bias);
    totalBias += bias;
  }
  for (const [k, v] of personalization) personalization.set(k, v / totalBias);

  // Init rank uniformly.
  let rank = new Map<string, number>();
  for (const f of files) rank.set(f.path, 1 / N);

  const damping = 0.85;
  for (let iter = 0; iter < 25; iter++) {
    const next = new Map<string, number>();
    for (const f of files) next.set(f.path, (1 - damping) * (personalization.get(f.path) ?? 1 / N));
    for (const f of files) {
      const out = adj.get(f.path)!;
      if (out.length === 0) continue;
      const share = (rank.get(f.path) ?? 0) / out.length;
      for (const t of out) {
        next.set(t, (next.get(t) ?? 0) + damping * share);
      }
    }
    rank = next;
  }
  return rank;
}

/**
 * Render the repo map as a token-budgeted text block. Highest-ranked
 * files first, signatures elided to one per line. Drops the bottom
 * of the list when the running token estimate exceeds `budget`.
 */
function renderRepoMap(
  files: FileEntry[],
  rank: Map<string, number>,
  budget = 1024,
): string {
  // Approx 4 chars / token.
  const charBudget = budget * 4;
  const sorted = [...files].sort(
    (a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0),
  );
  const out: string[] = [];
  let charsUsed = 0;
  for (const f of sorted) {
    if (f.defs.length === 0) continue;
    const header = `${f.path}:`;
    const lines = f.defs.slice(0, 12).map((d) => `  ${d.signature}`);
    const block = [header, ...lines].join('\n') + '\n';
    if (charsUsed + block.length > charBudget) break;
    out.push(block);
    charsUsed += block.length;
  }
  if (out.length === 0) return '';
  return out.join('\n');
}

interface BuildArgs {
  /** Absolute path of the workspace root. When null/empty, build is
   *  a no-op and returns ''. */
  workspaceRoot: string | null;
  activeFilePath?: string | null;
  openPaths?: string[];
  recentPaths?: string[];
  budgetTokens?: number;
}

const REPOMAP_CACHE_KEY = 'suxai.repomap.v1';

interface RepoMapCacheEntry {
  workspaceRoot: string;
  ts: number;
  text: string;
}

function loadRepoMapCache(): RepoMapCacheEntry[] {
  try {
    const raw = localStorage.getItem(REPOMAP_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveRepoMapCache(entries: RepoMapCacheEntry[]): void {
  try {
    localStorage.setItem(REPOMAP_CACHE_KEY, JSON.stringify(entries.slice(-8)));
  } catch {
    /* quota exceeded — skip */
  }
}

/**
 * Build the repo map for a workspace. Returns the rendered text
 * (≤ budgetTokens worth of signatures) or '' on empty / error.
 *
 * Uses the global window.suxai.fs IPC to read the workspace.
 * Cached in localStorage for 5 minutes per workspace — good enough
 * for the typical "switch tabs, run agent again" flow without
 * re-walking the tree.
 */
export async function buildRepoMap(args: BuildArgs): Promise<string> {
  const { workspaceRoot } = args;
  if (!workspaceRoot) return '';
  if (typeof window === 'undefined' || !window.suxai?.fs) return '';

  const cache = loadRepoMapCache();
  const cached = cache.find((c) => c.workspaceRoot === workspaceRoot);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return cached.text;
  }

  const fs = window.suxai.fs;
  const paths = await listFilesRecursive(workspaceRoot, fs.readDir);
  if (paths.length === 0) return '';

  const files: FileEntry[] = [];
  for (const p of paths) {
    let content: string;
    try {
      const r = await fs.readFile(p);
      content = r.content;
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) continue;
    const language = languageOf(p);
    const defs = extractDefs(content, language);
    const refs = extractRefs(content, language);
    if (defs.length === 0 && refs.length === 0) continue;
    files.push({ path: p, language, defs, refs, size: content.length });
  }

  const rank = pageRank(files, {
    activeFilePath: args.activeFilePath ?? null,
    openPaths: args.openPaths ?? [],
    recentPaths: args.recentPaths ?? [],
  });
  const text = renderRepoMap(files, rank, args.budgetTokens ?? 1024);

  // Cache.
  const next = cache.filter((c) => c.workspaceRoot !== workspaceRoot);
  next.push({ workspaceRoot, ts: Date.now(), text });
  saveRepoMapCache(next);

  return text;
}

/**
 * Wrap the rendered text in a <repo_map> block ready to inject
 * into a system or user message. Returns '' when the repo had no
 * useful symbols to surface — caller should skip the prepend in
 * that case to avoid wasting cache breakpoints on empty noise.
 */
export function formatRepoMapBlock(text: string): string {
  if (!text.trim()) return '';
  return (
    '<repo_map>\n' +
    'Top-ranked files in this workspace, with their signatures only.\n' +
    'Use this as a structural overview before calling read_file or grep.\n\n' +
    text +
    '\n</repo_map>'
  );
}
