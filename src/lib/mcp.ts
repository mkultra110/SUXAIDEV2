import { useEffect, useState } from 'react';

/**
 * v0.16.10 — Renderer wrapper around the MCP IPC surface (electron
 * main process owns the actual server lifecycle + JSON-RPC stdio).
 *
 * Foundations release : configure servers via Settings → MCP, see
 * connection status, list discovered tools. Agent loop integration
 * (auto-injecting MCP tools into the agent's tool surface) is
 * deliberately deferred to a future version since it would touch
 * src/lib/agent.ts which is audit-protected.
 */

export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  status: 'starting' | 'ready' | 'error';
  errorMsg?: string;
  toolCount: number;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
}

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface McpConfig {
  servers?: Record<string, McpServerSpec>;
}

const REFRESH_EVENT = 'suxai:mcp-refresh';

export async function listServers(): Promise<McpServerInfo[]> {
  if (!window.suxai?.mcp?.listServers) return [];
  try { return await window.suxai.mcp.listServers(); }
  catch { return []; }
}

export async function listTools(server?: string): Promise<McpToolInfo[]> {
  if (!window.suxai?.mcp?.listTools) return [];
  try { return await window.suxai.mcp.listTools({ server }); }
  catch { return []; }
}

export async function callTool(
  server: string,
  tool: string,
  args?: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!window.suxai?.mcp?.callTool) return { ok: false, error: 'mcp IPC unavailable' };
  return window.suxai.mcp.callTool({ server, tool, arguments: args });
}

export async function readMcpConfig(): Promise<{ config: McpConfig; path: string }> {
  if (!window.suxai?.mcp?.readConfig) return { config: { servers: {} }, path: '' };
  try {
    const res = await window.suxai.mcp.readConfig();
    return { config: res.config as McpConfig, path: res.path };
  } catch {
    return { config: { servers: {} }, path: '' };
  }
}

export async function saveMcpConfig(config: McpConfig): Promise<string | null> {
  if (!window.suxai?.mcp?.saveConfig) return 'mcp IPC unavailable';
  try {
    const res = await window.suxai.mcp.saveConfig({ config });
    if (res.ok) {
      window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
      return null;
    }
    return res.error;
  } catch (err) {
    return (err as Error).message;
  }
}

export function broadcastMcpRefresh(): void {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

/** React hook — returns the current server list, refreshes on mount,
 *  on an internal 5 s poll while at least one server is in
 *  'starting' state, and on every saveMcpConfig() broadcast. */
export function useMcpServers(): McpServerInfo[] {
  const [servers, setServers] = useState<McpServerInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const list = await listServers();
      if (!cancelled) setServers(list);
    };
    void load();
    const handler = () => { void load(); };
    window.addEventListener(REFRESH_EVENT, handler);
    // Light polling : if any server is still 'starting', re-poll
    // every 2 s until they all settle.
    let pollTimer: NodeJS.Timeout | null = null;
    const tick = async () => {
      const list = await listServers();
      if (cancelled) return;
      setServers(list);
      if (list.some((s) => s.status === 'starting')) {
        pollTimer = setTimeout(tick, 2_000);
      }
    };
    pollTimer = setTimeout(tick, 2_000);
    return () => {
      cancelled = true;
      window.removeEventListener(REFRESH_EVENT, handler);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  return servers;
}
