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
];

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

const MAX_FILE_BYTES = 200_000;
const MAX_DIR_ENTRIES = 200;

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
