/**
 * Agent tools + executor.
 *
 * The agent mode lets the model decide when to read files, list folders,
 * or edit code on its own. Each tool here is a thin wrapper over our
 * existing window.suxai.fs IPC, with output trimmed to keep the model's
 * context tight.
 *
 * The model's tool calls come back from the server as JSON via the SSE
 * stream; the AIPanel agent loop dispatches them here.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      "Read the full contents of a file from the user's workspace. Use this when you need to inspect code you haven't been shown yet. Always read before editing.",
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description:
      "List the immediate children of a directory in the user's workspace. Use this to explore the project structure when you don't know where files live.",
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description:
      "Make a targeted edit to an existing file by replacing one specific snippet with another. The 'search' string must appear EXACTLY ONCE in the file. Prefer surgical edits over rewriting whole files. Returns the diff that was applied. Requires user approval before being committed to disk.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        search: {
          type: 'string',
          description: 'Exact substring to find. Must match exactly once.',
        },
        replace: {
          type: 'string',
          description: 'New text to put in place of the matched substring.',
        },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'write_file',
    description:
      "Create a new file or completely overwrite an existing one. Only use this for new files or when an edit_file would touch most of the file. Requires user approval.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        content: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description:
      "Run a shell command in the user's workspace (e.g. `npm run build`, `pytest`, `git status`). Output is captured and returned. Requires user approval. Combine commands with `&&`; don't invoke interactive tools (no vim / htop — they have no TTY). Append `| cat` where a pager would block (git log, less). Default timeout 120 seconds.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command line.' },
        cwd: {
          type: 'string',
          description: 'Optional working directory; defaults to the workspace root.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Max runtime in milliseconds (default 120000, max 600000).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'grep',
    description:
      "Search the user's workspace for a regex pattern. Powered by ripgrep when available, falls back to a Node walk otherwise. Returns up to 100 matches by default with file path + line number + matching line. Prefer this over reading every file when looking for symbol definitions, callers, TODO markers, or any regex you'd grep for at the shell.",
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern. Anchor it (^, $, \\b) to keep noise low.',
        },
        glob: {
          type: 'string',
          description:
            'Optional file pattern (e.g. "**/*.ts", "src/**/*.cpp") to scope the search. Trailing extension is honoured even by the Node fallback.',
        },
        max_results: {
          type: 'integer',
          description: 'Cap on returned matches (default 100, max 500).',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'When true, match case strictly. Defaults to false.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'apply_lazy_edit',
    description:
      "Apply a 'lazy edit' to a large existing file. Use this INSTEAD of edit_file when you want to change MULTIPLE non-contiguous regions of a big file (>200 lines) without rewriting everything. Emit a `lazy_edit` body that contains the new code plus `// ... existing code ...` (or the language-equivalent: `# ... existing code ...` for Python, `<!-- ... existing code ... -->` for HTML/Markdown) marker comments around the unchanged regions. A fast apply model (Haiku 4.5) merges your lazy edit into the original file, then the user reviews the resulting diff hunk-by-hunk in the inline diff. Cheaper than emitting the full file yourself; faster than chaining many edit_file calls.",
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to edit. Must already exist.',
        },
        instruction: {
          type: 'string',
          description:
            'Short user-facing description of what this edit does. Helps the apply model resolve marker ambiguity. e.g. "Add a streamproof check to renderEntity and rename initOnce to setupRenderer".',
        },
        lazy_edit: {
          type: 'string',
          description:
            'The new code with `// ... existing code ...` markers around unchanged regions. Markers MUST be on lines by themselves (no inline). Match the comment style of the file\'s language.',
        },
      },
      required: ['path', 'lazy_edit', 'instruction'],
    },
  },
  {
    name: 'codebase_search',
    description:
      "Semantic-ish search across the user's workspace. Takes a NATURAL LANGUAGE query (e.g. 'where is auth handled', 'find the renderer entry point', 'what manages stream proof'), tokenises it into keywords, runs multiple greps in parallel, and ranks the matching files using the repo's PageRank. Returns up to 8 file:line:snippet hits ordered by relevance. Use this BEFORE listing many files or reading speculatively — it's the cheapest way to discover where a concept lives.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language description of what to find. Will be tokenised and grepped against the workspace.',
        },
        top_k: {
          type: 'integer',
          description: 'How many snippets to return (default 8, max 20).',
        },
      },
      required: ['query'],
    },
  },
  {
    // Plan-mode-only tool. Available to the agent when the
    // conversation runs in 'ask' mode. Writes a structured markdown
    // plan that the user can review before flipping back to composer
    // mode for execution.
    name: 'create_plan',
    description:
      "[Plan mode only] Write a structured implementation plan to .suxai/plans/<slug>.md. Use this INSTEAD of edit_file/write_file when in Plan mode. The plan should follow the structure: ## Context, ## Per-file analysis (markdown table file/issue/fix), ## Already OK (checklist), ## Implementation Plan (numbered), ## Walkthrough (collapsible <details>), ## Acceptance Criteria. The user reviews then toggles agent mode to execute.",
    input_schema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description:
            'Short kebab-case filename without extension (e.g. "fix-streamproof"). Will become .suxai/plans/<slug>.md.',
        },
        content: {
          type: 'string',
          description: 'Full markdown body of the plan.',
        },
      },
      required: ['slug', 'content'],
    },
  },
];

/**
 * Filter the AGENT_TOOLS list according to the conversation mode.
 *   - 'composer' (default) → all tools INCLUDING run_command, MINUS
 *     create_plan (which is plan-mode-only).
 *   - 'ask' → read-only tools (read_file, list_dir) + create_plan.
 *     edit_file / write_file / run_command are dropped to prevent
 *     accidental side effects during the planning phase.
 */
export function toolsForMode(mode: 'composer' | 'ask' = 'composer'): ToolDefinition[] {
  if (mode === 'ask') {
    // Plan / Ask mode: read-only investigation tools only. grep +
    // codebase_search both included so Plan can locate references
    // before drafting the markdown plan.
    return AGENT_TOOLS.filter((t) =>
      t.name === 'read_file' ||
      t.name === 'list_dir' ||
      t.name === 'grep' ||
      t.name === 'codebase_search' ||
      t.name === 'create_plan',
    );
  }
  // Composer drops create_plan (plan-mode-only); everything else
  // including codebase_search and apply_lazy_edit is exposed.
  return AGENT_TOOLS.filter((t) => t.name !== 'create_plan');
}

/**
 * Regex patterns that bypass any auto-approve policy. If the command
 * matches ANY of these, the approval dialog is forced — the model can't
 * slip past with a "looks safe" argument.
 */
const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\s+(\/|~|\$HOME|\*)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)/,
  /\bgit\s+push\s+[^&\n]*--force\b/,
  /\bnpm\s+(publish|unpublish)\b/,
  /\byarn\s+publish\b/,
  />\s*\/dev\/(sd[a-z]+\d*|hd[a-z]+\d*|nvme\d+n\d+(p\d+)?|mmcblk\d+(p\d+)?|disk\d*|loop\d+)\b/,
  /\bshutdown\b/,
  /\bdd\s+.*\bof=\/dev\//,
  /\bchmod\s+-R\s+0?777\b/,
];

export function detectDangerousCommand(cmd: string): boolean {
  return DANGER_PATTERNS.some((re) => re.test(cmd));
}

// Reading caps: allow large files in one tool call so the agent can
// inspect entire codebases without slicing them into chunks. The
// effective ceiling is bounded by the server's per-block cap (4 MB,
// see server/src/schemas/ai.ts). Anything bigger is auto-truncated
// with a "[TRUNCATED — file is X bytes]" footer so the model knows
// it's not seeing the full thing and can ask for a tighter slice.
const MAX_FILE_BYTES = 1_500_000; // ~1.5 MB
const MAX_DIR_ENTRIES = 400;

/**
 * Directories the agent should never list — they're huge, almost
 * never relevant to the model's task, and burn through the context
 * window. Mirror what `git status` would already gitignore by default.
 */
const NOISY_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'dist-electron',
  'build',
  'release',
  '.next',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.idea',
  '.vscode',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.DS_Store',
]);

/**
 * Heuristic binary detection: scan the first chunk for NUL bytes or a
 * heavy ratio of non-printable characters. Good enough for the agent
 * to refuse images/exes without dragging in a libmagic dep.
 */
function looksBinary(content: string): boolean {
  if (content.length === 0) return false;
  const sample = content.slice(0, 4096);
  if (sample.includes('\0')) return true;
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Printable ASCII + common whitespace, or any extended unicode (>=0x80).
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32) nonPrintable++;
  }
  return nonPrintable / sample.length > 0.05;
}

/**
 * Approval callback the executor invokes before any file-modifying tool.
 * Resolves with:
 *   - `ok=false` → tool aborted, return rejected message to the model
 *   - `ok=true,  written=false` → executor performs its own write
 *   - `ok=true,  written=true`  → the approval UI already wrote the
 *     file (e.g. an inline diff that the user accepted hunk-by-hunk
 *     and persisted itself). Skip the executor's write so we don't
 *     double-write or stomp the user's hunk-level decisions.
 */
export interface ApproveResult {
  ok: boolean;
  /** True if the approval UI already persisted to disk. */
  written?: boolean;
  /** Final content actually written, when `written=true`. */
  finalContent?: string;
}
export type ApproveFn = (
  call: ToolCall,
  /** Extra UX hint — for edit_file we pass the proposed diff. */
  preview?: { path: string; original: string; proposed: string },
) => Promise<ApproveResult | boolean>;

function normalizeApprove(r: ApproveResult | boolean): ApproveResult {
  return typeof r === 'boolean' ? { ok: r } : r;
}

export class ToolExecutionError extends Error {
  constructor(public toolName: string, message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw new ToolExecutionError('?', 'Tool input must be an object');
  }
  return input as Record<string, unknown>;
}

function expectString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolExecutionError('?', `Missing or invalid string field: ${key}`);
  }
  return v;
}

export interface ExecuteOptions {
  approve: ApproveFn;
  /** Absolute path of the user's workspace, when known. Required by
   *  tools that scope their writes to <workspace>/.suxai/ (e.g.
   *  create_plan). Tools that don't need it (read_file, edit_file)
   *  just ignore this. */
  workspaceRoot?: string | null;
  /** Apply-model bridge for the apply_lazy_edit tool. Resolves to
   *  the merged file content (or null on failure). Provided by
   *  AIPanel which knows the JWT and the VPS endpoint. */
  applyLazyEdit?: (input: {
    path: string;
    original: string;
    lazy_edit: string;
    instruction?: string;
  }) => Promise<string | null>;
}

export async function executeTool(
  call: ToolCall,
  opts: ExecuteOptions,
): Promise<ToolResult> {
  try {
    const out = await runOne(call, opts);
    return { tool_use_id: call.id, content: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { tool_use_id: call.id, content: msg, is_error: true };
  }
}

async function runOne(call: ToolCall, opts: ExecuteOptions): Promise<string> {
  const args = asObject(call.input);
  switch (call.name) {
    case 'read_file': {
      const path = expectString(args, 'path');
      const f = await window.suxai.fs.readFile(path);
      if (looksBinary(f.content)) {
        return (
          `<<<file path=${f.path} binary=true>>>\n` +
          `[binary or non-text file; ${f.content.length} bytes — refusing to inline. ` +
          `If you must inspect it, ask the user for guidance.]\n<<<end>>>`
        );
      }
      const truncated = f.content.length > MAX_FILE_BYTES;
      const body = truncated
        ? f.content.slice(0, MAX_FILE_BYTES) +
          `\n\n[TRUNCATED — file is ${f.content.length} bytes; first ${MAX_FILE_BYTES} shown]`
        : f.content;
      return `<<<file path=${f.path}>>>\n${body}\n<<<end>>>`;
    }
    case 'list_dir': {
      const path = expectString(args, 'path');
      const all = await window.suxai.fs.readDir(path);
      // Sort: directories first, then alphabetical, with noisy/hidden
      // entries pushed to the bottom so the model sees the meaningful
      // children first. Hidden files (`.*`) other than NOISY_DIRS keep
      // their place — `.env.example` and `.gitignore` matter.
      const visible = all
        .filter((e) => !NOISY_DIRS.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      const hidden = all.filter((e) => NOISY_DIRS.has(e.name));
      const truncated = visible.length > MAX_DIR_ENTRIES;
      const lines = visible.slice(0, MAX_DIR_ENTRIES).map(
        (e) => `${e.isDirectory ? 'D' : 'F'}  ${e.path}`,
      );
      if (truncated) {
        lines.push(`[TRUNCATED — ${visible.length - MAX_DIR_ENTRIES} more entries omitted]`);
      }
      if (hidden.length > 0) {
        lines.push(
          `[hidden by gitignore-default: ${hidden.map((e) => e.name).join(', ')}]`,
        );
      }
      return `<<<dir path=${path}>>>\n${lines.join('\n')}\n<<<end>>>`;
    }
    case 'edit_file': {
      const path = expectString(args, 'path');
      const search = expectString(args, 'search');
      const replace = typeof args.replace === 'string' ? (args.replace as string) : '';
      const f = await window.suxai.fs.readFile(path);
      const occurrences = countOccurrences(f.content, search);
      if (occurrences === 0) {
        throw new ToolExecutionError(
          'edit_file',
          `The 'search' string was not found in ${path}. Re-read the file and try again with the exact text.`,
        );
      }
      if (occurrences > 1) {
        throw new ToolExecutionError(
          'edit_file',
          `The 'search' string appears ${occurrences} times in ${path}. Make it unique by including more surrounding context.`,
        );
      }
      const proposed = f.content.replace(search, replace);
      const approval = normalizeApprove(
        await opts.approve(call, {
          path,
          original: f.content,
          proposed,
        }),
      );
      if (!approval.ok) {
        return `User rejected the edit to ${path}.`;
      }
      // If the approval UI (inline diff) already wrote the user's
      // hunk-by-hunk decisions to disk, don't re-write — the user may
      // have intentionally rejected some hunks. Otherwise, fall back
      // to writing the model's full proposed text.
      const finalText = approval.finalContent ?? proposed;
      if (!approval.written) {
        await window.suxai.fs.writeFile(path, finalText);
      }
      const lines = finalText.split('\n').length - f.content.split('\n').length;
      const partial =
        approval.finalContent && approval.finalContent !== proposed
          ? ' (some hunks were rejected by the user)'
          : '';
      return `Edit applied to ${path}. Net line delta: ${lines >= 0 ? `+${lines}` : lines}.${partial}`;
    }
    case 'write_file': {
      const path = expectString(args, 'path');
      const content = typeof args.content === 'string' ? (args.content as string) : '';
      let original = '';
      try {
        original = (await window.suxai.fs.readFile(path)).content;
      } catch {
        // file doesn't exist — that's fine for a create
      }
      const approval = normalizeApprove(
        await opts.approve(call, {
          path,
          original,
          proposed: content,
        }),
      );
      if (!approval.ok) return `User rejected the write to ${path}.`;
      const finalText = approval.finalContent ?? content;
      if (!approval.written) {
        await window.suxai.fs.writeFile(path, finalText);
      }
      return `Wrote ${finalText.length} bytes to ${path}.`;
    }
    case 'run_command': {
      const command = expectString(args, 'command');
      const cwd = typeof args.cwd === 'string' ? (args.cwd as string) : undefined;
      const timeout_ms = typeof args.timeout_ms === 'number' ? (args.timeout_ms as number) : undefined;
      const ok = await opts.approve(call);
      if (!ok) return `User rejected the command: ${command}`;
      if (!window.suxai.terminal?.runOnce) {
        throw new ToolExecutionError('run_command', 'Terminal IPC unavailable');
      }
      const result = await window.suxai.terminal.runOnce({ command, cwd, timeout_ms });
      const header = `$ ${command}${cwd ? `  (cwd: ${cwd})` : ''}`;
      if (result.error) {
        throw new ToolExecutionError('run_command', `${header}\n${result.error}`);
      }
      const exitLine = result.timed_out
        ? `[timed out after ${timeout_ms ?? 120000}ms]`
        : `[exit ${result.exit_code}]`;
      return `${header}\n${result.stdout}\n${exitLine}`;
    }
    case 'grep': {
      const pattern = expectString(args, 'pattern');
      const glob = typeof args.glob === 'string' ? args.glob : undefined;
      const max_results = typeof args.max_results === 'number' ? args.max_results : undefined;
      const case_sensitive = typeof args.case_sensitive === 'boolean' ? args.case_sensitive : undefined;
      if (!opts.workspaceRoot) {
        throw new ToolExecutionError(
          'grep',
          'No workspace root open — grep needs a folder context. Open a folder first.',
        );
      }
      if (!window.suxai.search?.grep) {
        throw new ToolExecutionError(
          'grep',
          'grep IPC unavailable. Update SUXAI to a build with v0.9.22+.',
        );
      }
      const out = await window.suxai.search.grep({
        pattern,
        cwd: opts.workspaceRoot,
        glob,
        max_results,
        case_sensitive,
      });
      if (!out.hits || out.hits.length === 0) {
        const detail = out.error ? ` (${out.error})` : '';
        return `<<<grep pattern=${JSON.stringify(pattern)} hits=0${detail}>>>\n(no matches)\n<<<end>>>`;
      }
      const sourceTag = out.source ? ` source=${out.source}` : '';
      const lines = out.hits.map(
        (h) => `${h.path}:${h.line}: ${h.text}`,
      );
      return (
        `<<<grep pattern=${JSON.stringify(pattern)} hits=${out.hits.length}${sourceTag}>>>\n` +
        lines.join('\n') +
        `\n<<<end>>>`
      );
    }
    case 'apply_lazy_edit': {
      const path = expectString(args, 'path');
      const lazy_edit = expectString(args, 'lazy_edit');
      const instruction = typeof args.instruction === 'string' ? (args.instruction as string) : '';
      // Read the original file. Bail loudly if it doesn't exist —
      // apply_lazy_edit is for EXISTING files; new files should use
      // write_file directly.
      let original: string;
      try {
        const r = await window.suxai.fs.readFile(path);
        original = r.content;
      } catch (err) {
        throw new ToolExecutionError(
          'apply_lazy_edit',
          `Could not read ${path}: ${(err as Error).message}. ` +
            `Use write_file to create new files.`,
        );
      }
      if (!opts.applyLazyEdit) {
        throw new ToolExecutionError(
          'apply_lazy_edit',
          'Apply IPC unavailable. Update SUXAI to a build with v0.11+.',
        );
      }
      const merged = await opts.applyLazyEdit({
        path,
        original,
        lazy_edit,
        instruction,
      });
      if (merged == null) {
        throw new ToolExecutionError(
          'apply_lazy_edit',
          'Apply model returned no result. Falling back: try edit_file with explicit search/replace blocks instead.',
        );
      }
      // Hand the merged content to the same approval flow as edit_file:
      // routes through the InlineDiff so the user accepts/rejects hunk-
      // by-hunk before disk write.
      const approval = normalizeApprove(
        await opts.approve(call, {
          path,
          original,
          proposed: merged,
        }),
      );
      if (!approval.ok) {
        return `User rejected the lazy edit on ${path}.`;
      }
      const finalText = approval.finalContent ?? merged;
      if (!approval.written) {
        await window.suxai.fs.writeFile(path, finalText);
      }
      const lineDelta = finalText.split('\n').length - original.split('\n').length;
      const partial =
        approval.finalContent && approval.finalContent !== merged
          ? ' (some hunks were rejected by the user)'
          : '';
      return `Lazy edit applied to ${path}. Net line delta: ${lineDelta >= 0 ? `+${lineDelta}` : lineDelta}.${partial}`;
    }
    case 'codebase_search': {
      const query = expectString(args, 'query');
      const top_k = Math.min(Math.max(typeof args.top_k === 'number' ? args.top_k : 8, 1), 20);
      if (!opts.workspaceRoot) {
        throw new ToolExecutionError(
          'codebase_search',
          'No workspace root open. codebase_search needs a folder context.',
        );
      }
      if (!window.suxai.search?.grep) {
        throw new ToolExecutionError(
          'codebase_search',
          'search IPC unavailable. Update SUXAI to a build with v0.9.22+.',
        );
      }
      // Tokenise the natural-language query into keywords. Drop short
      // tokens (< 3 chars) and a small English/French stopword list
      // — they'd flood the grep with noise. Keep camelCase / snake_case
      // intact so "renderEntity" matches verbatim.
      const STOP = new Set([
        'the', 'and', 'for', 'with', 'this', 'that', 'where', 'what',
        'which', 'how', 'when', 'why', 'are', 'has', 'have', 'does',
        'did', 'is', 'was', 'be', 'been', 'being', 'find', 'show', 'tell',
        'give', 'get', 'ce', 'cette', 'cet', 'les', 'des', 'un', 'une',
        'qui', 'que', 'quoi', 'comment', 'fait', 'fais', 'sont', 'est',
        'avec', 'dans', 'pour', 'par', 'sur',
      ]);
      const tokens = query
        .replace(/[^\w\s_-]/g, ' ')
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !STOP.has(t.toLowerCase()))
        .slice(0, 6);
      if (tokens.length === 0) {
        return `<<<codebase_search query=${JSON.stringify(query)} hits=0>>>\n(no usable keywords after stopword filtering — try a more specific query)\n<<<end>>>`;
      }
      // Run a grep per keyword in parallel, accumulate hits keyed
      // by (path, line). Score each hit by the number of distinct
      // tokens that landed in it (TF-ish), then by how many tokens
      // that file matches overall (file-relevance).
      const keywordHits = await Promise.all(
        tokens.map((tok) =>
          window.suxai.search.grep({
            pattern: tok,
            cwd: opts.workspaceRoot!,
            max_results: 50,
            case_sensitive: false,
          }),
        ),
      );
      type Entry = { path: string; line: number; text: string; tokensMatched: Set<string> };
      const byKey = new Map<string, Entry>();
      const tokensByFile = new Map<string, Set<string>>();
      keywordHits.forEach((res, i) => {
        if (!res.hits) return;
        const tok = tokens[i];
        for (const h of res.hits) {
          const key = `${h.path}#${h.line}`;
          const existing = byKey.get(key);
          if (existing) {
            existing.tokensMatched.add(tok);
          } else {
            byKey.set(key, { ...h, tokensMatched: new Set([tok]) });
          }
          let set = tokensByFile.get(h.path);
          if (!set) { set = new Set(); tokensByFile.set(h.path, set); }
          set.add(tok);
        }
      });
      const ranked = [...byKey.values()].sort((a, b) => {
        const aFile = tokensByFile.get(a.path)?.size ?? 0;
        const bFile = tokensByFile.get(b.path)?.size ?? 0;
        // Order by (file token coverage, hit token coverage). Files
        // that match many distinct tokens beat files matching only one.
        if (aFile !== bFile) return bFile - aFile;
        return b.tokensMatched.size - a.tokensMatched.size;
      });
      const top = ranked.slice(0, top_k);
      if (top.length === 0) {
        return `<<<codebase_search query=${JSON.stringify(query)} tokens=${JSON.stringify(tokens)} hits=0>>>\n(no matches)\n<<<end>>>`;
      }
      const formatted = top
        .map((h) => {
          const tags = [...h.tokensMatched].join(',');
          return `${h.path}:${h.line} [matched: ${tags}]\n  ${h.text}`;
        })
        .join('\n');
      return (
        `<<<codebase_search query=${JSON.stringify(query)} tokens=${JSON.stringify(tokens)} hits=${top.length}>>>\n` +
        formatted +
        `\n<<<end>>>`
      );
    }
    case 'create_plan': {
      // Plan-mode-only tool. Persists a markdown plan to
      // <workspace>/.suxai/plans/<slug>.md, opens it in the editor
      // as a preview, and returns a short confirmation. No approval
      // needed — write target is sandboxed under .suxai/.
      const slug = expectString(args, 'slug')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
      if (!slug) {
        throw new ToolExecutionError(
          'create_plan',
          'slug must contain at least one alphanumeric character',
        );
      }
      const content = typeof args.content === 'string' ? (args.content as string) : '';
      if (!content.trim()) {
        throw new ToolExecutionError('create_plan', 'content cannot be empty');
      }
      if (!window.suxai.plan?.write) {
        throw new ToolExecutionError(
          'create_plan',
          'Plan IPC unavailable. Update SUXAI to a build with v0.9.19+.',
        );
      }
      if (!opts.workspaceRoot) {
        throw new ToolExecutionError(
          'create_plan',
          'Plan mode requires an open workspace. Open a folder first.',
        );
      }
      const result = await window.suxai.plan.write(opts.workspaceRoot, slug, content);
      return (
        `Plan saved to ${result.path}. ` +
        `${content.split('\n').length} lines. The user can review it now ` +
        `and toggle Plan mode off when ready to execute.`
      );
    }
    default:
      throw new ToolExecutionError(call.name, `Unknown tool: ${call.name}`);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count++;
    from = idx + needle.length;
  }
}
