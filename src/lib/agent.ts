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
];

const MAX_FILE_BYTES = 200_000;
const MAX_DIR_ENTRIES = 200;

/**
 * Approval callback the executor invokes before any file-modifying tool.
 * Should resolve to `true` to proceed, `false` to cancel.
 */
export type ApproveFn = (
  call: ToolCall,
  /** Extra UX hint — for edit_file we pass the proposed diff. */
  preview?: { path: string; original: string; proposed: string },
) => Promise<boolean>;

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
      const truncated = f.content.length > MAX_FILE_BYTES;
      const body = truncated
        ? f.content.slice(0, MAX_FILE_BYTES) +
          `\n\n[TRUNCATED — file is ${f.content.length} bytes; first ${MAX_FILE_BYTES} shown]`
        : f.content;
      return `<<<file path=${f.path}>>>\n${body}\n<<<end>>>`;
    }
    case 'list_dir': {
      const path = expectString(args, 'path');
      const entries = await window.suxai.fs.readDir(path);
      const truncated = entries.length > MAX_DIR_ENTRIES;
      const lines = entries.slice(0, MAX_DIR_ENTRIES).map(
        (e) => `${e.isDirectory ? 'D' : 'F'}  ${e.path}`,
      );
      if (truncated) {
        lines.push(`[TRUNCATED — ${entries.length - MAX_DIR_ENTRIES} more entries omitted]`);
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
      const ok = await opts.approve(call, {
        path,
        original: f.content,
        proposed,
      });
      if (!ok) {
        return `User rejected the edit to ${path}.`;
      }
      await window.suxai.fs.writeFile(path, proposed);
      const lines = proposed.split('\n').length - f.content.split('\n').length;
      return `Edit applied to ${path}. Net line delta: ${lines >= 0 ? `+${lines}` : lines}.`;
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
      const ok = await opts.approve(call, {
        path,
        original,
        proposed: content,
      });
      if (!ok) return `User rejected the write to ${path}.`;
      await window.suxai.fs.writeFile(path, content);
      return `Wrote ${content.length} bytes to ${path}.`;
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
