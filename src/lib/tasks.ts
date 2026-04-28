import { useEffect, useState } from 'react';
import { runStream } from './run-stream';

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
  // v3.6 → v3.8 — utilise `runStream` pour pousser chaque chunk
  // dans la source `Task: <label>` du panneau Output au fur et à
  // mesure. Le shape de retour reste identique pour la compat des
  // appelants (CommandPalette, etc.).
  const res = await runStream({
    command: task.command,
    cwd,
    timeout_ms: timeoutMs,
    source: `Task: ${task.label}`,
  });
  if (!res.ok) {
    return { ok: false, error: res.error ?? 'task failed' };
  }
  return {
    ok: true,
    stdout: res.stdout,
    exitCode: res.exit_code,
    timedOut: res.timed_out,
  };
}
