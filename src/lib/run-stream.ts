/**
 * v3.8 — Live-stream command runner.
 *
 * Spawns a shell command via `terminal:run-stream` IPC, pushing
 * each stdout/stderr chunk to the named Output panel source as it
 * arrives, and resolves with the final result + buffered stdout
 * when the process exits.
 *
 * Drop-in replacement for `runOnce` when the caller wants live
 * progress visible to the user — e.g. `runTask` (workspace
 * tasks), the agent's `run_command` tool, or a future build runner.
 *
 * The `id` parameter is auto-generated if omitted ; multiple
 * concurrent runStream calls are safe (chunks are dispatched
 * by id).
 */
import { appendOutput } from './output';

export interface RunStreamInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  /** Output panel source — e.g. "Task: Lint" or "Agent". */
  source: string;
  /** Optional banner before the first chunk. Defaults to `$ <command>`. */
  banner?: string;
  /** Pre-supplied id (otherwise auto-generated). */
  id?: string;
}

export interface RunStreamResult {
  ok: boolean;
  stdout: string;
  exit_code: number;
  timed_out: boolean;
  error?: string;
}

export async function runStream(input: RunStreamInput): Promise<RunStreamResult> {
  if (!window.suxai?.terminal?.runStream) {
    return {
      ok: false,
      stdout: '',
      exit_code: -1,
      timed_out: false,
      error: 'terminal IPC unavailable',
    };
  }
  const id = input.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  appendOutput(input.source, input.banner ?? `$ ${input.command}`, 'info');
  let buffered = '';
  let timed_out = false;
  let exit_code = -1;
  let error: string | undefined;

  const offChunk = window.suxai.terminal.onRunStreamChunk((evt) => {
    if (evt.id !== id) return;
    buffered += evt.text;
    appendOutput(input.source, evt.text, evt.level === 'stderr' ? 'stderr' : 'stdout');
  });

  const endPromise = new Promise<void>((resolve) => {
    const offEnd = window.suxai.terminal.onRunStreamEnd((evt) => {
      if (evt.id !== id) return;
      exit_code = evt.exit_code;
      timed_out = !!evt.timed_out;
      error = evt.error;
      offChunk();
      offEnd();
      resolve();
    });
  });

  try {
    await window.suxai.terminal.runStream({
      id,
      command: input.command,
      cwd: input.cwd,
      timeout_ms: input.timeout_ms,
    });
  } catch (err) {
    offChunk();
    error = (err as Error).message;
  }
  await endPromise;

  appendOutput(
    input.source,
    error
      ? `[error] ${error}`
      : timed_out
        ? `[timed out after ${input.timeout_ms ?? 120_000}ms]`
        : `[exit ${exit_code}]`,
    error || timed_out || exit_code !== 0 ? 'error' : 'info',
  );

  return {
    ok: !error,
    stdout: buffered,
    exit_code,
    timed_out,
    error,
  };
}
