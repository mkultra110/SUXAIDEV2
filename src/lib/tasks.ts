import { useEffect, useState } from 'react';
import { appendOutput } from './output';

/**
 * v0.16.12 — Workspace tasks.
 *
 * VSCode-compatible (subset of) `.suxai/tasks.json` :
 *   {
 *     "version": "1.0",
 *     "tasks": [
 *       { "label": "Build", "command": "npm run build", "group": "build" },
 *       { "label": "Test", "command": "npm test", "group": "test" }
 *     ]
 *   }
 *
 * Tasks appear in the Command Palette under the "Tasks" group and
 * run via the existing terminal:run-once IPC (one-shot, captures
 * stdout/exit, toast with truncated output).
 */

export interface Task {
  label: string;
  command: string;
  group?: string;
  description?: string;
}

const REFRESH_EVENT = 'suxai:tasks-refresh';

export async function readTasks(workspaceRoot: string | null): Promise<Task[]> {
  if (!workspaceRoot || !window.suxai?.tasks?.read) return [];
  try {
    const res = await window.suxai.tasks.read({ cwd: workspaceRoot });
    return res.ok ? res.tasks : [];
  } catch {
    return [];
  }
}

/** React hook : returns the tasks for the current workspace. */
export function useTasks(workspaceRoot: string | null): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const list = await readTasks(workspaceRoot);
      if (!cancelled) setTasks(list);
    };
    void load();
    const handler = () => { void load(); };
    window.addEventListener(REFRESH_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(REFRESH_EVENT, handler);
    };
  }, [workspaceRoot]);
  return tasks;
}

export function broadcastTasksRefresh(): void {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

/** Run a task via the terminal:run-once IPC. Returns the captured
 *  stdout + exit code, or an error message on IPC failure. */
export async function runTask(
  task: Task,
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ ok: true; stdout: string; exitCode: number; timedOut?: boolean } | { ok: false; error: string }> {
  if (!window.suxai?.terminal?.runOnce) {
    return { ok: false, error: 'terminal IPC unavailable' };
  }
  // v3.6 — also write to the named OutputPanel source so the user
  // gets a persistent log (the toast still fires for quick feedback).
  const source = `Task: ${task.label}`;
  appendOutput(source, `$ ${task.command}`, 'info');
  try {
    const res = await window.suxai.terminal.runOnce({
      command: task.command,
      cwd,
      timeout_ms: timeoutMs,
    });
    if (res.error) {
      appendOutput(source, res.error, 'error');
      return { ok: false, error: res.error };
    }
    if (res.stdout) appendOutput(source, res.stdout, 'stdout');
    appendOutput(
      source,
      res.timed_out
        ? `[timed out after ${timeoutMs}ms]`
        : `[exit ${res.exit_code}]`,
      res.exit_code === 0 && !res.timed_out ? 'info' : 'error',
    );
    return {
      ok: true,
      stdout: res.stdout,
      exitCode: res.exit_code,
      timedOut: res.timed_out,
    };
  } catch (err) {
    const msg = (err as Error).message;
    appendOutput(source, msg, 'error');
    return { ok: false, error: msg };
  }
}
