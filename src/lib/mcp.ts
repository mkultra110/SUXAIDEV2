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

/* ====================================================================
 * v0.16.13 — Agent loop integration. Maps every connected MCP tool
 * into an Anthropic-compatible ToolDefinition (`mcp_<server>_<tool>`
 * naming) and provides an executor the AIPanel can call when a
 * tool_use block lands with a `mcp_*` name.
 *
 * Tool name sanitisation : Anthropic constrains tool names to
 * /^[a-zA-Z0-9_-]{1,64}$/. We slugify aggressively + truncate then
 * stash the original (server, tool) pair in a session-lived map so
 * we can route the call back to the right server.
 * ==================================================================== */

interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

interface McpRoute { server: string; tool: string }
const mcpRouteMap = new Map<string, McpRoute>();

function slugifyToolName(server: string, tool: string): string {
  const raw = `mcp_${server}_${tool}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned;
}

/** Fetch every MCP tool from connected servers and convert each to
 *  an Anthropic ToolDefinition. Refreshes the route map as a side
 *  effect so the matching executeMcpTool can find the back-mapping
 *  by simple lookup. */
export async function buildAgentToolDefinitions(): Promise<AgentToolDefinition[]> {
  if (!window.suxai?.mcp?.listServers || !window.suxai?.mcp?.listTools) return [];
  const servers = await listServers();
  const ready = servers.filter((s) => s.status === 'ready');
  if (ready.length === 0) return [];
  // Per-server fetch with detailed schemas. listTools returns just
  // {server, name, description}. We need inputSchema too — query the
  // raw tool list from the IPC handler with the per-server filter.
  const out: AgentToolDefinition[] = [];
  // Snapshot the current map and re-build to drop entries from
  // servers that have since disappeared.
  mcpRouteMap.clear();
  for (const s of ready) {
    const tools = await listTools(s.name);
    for (const t of tools) {
      const promptName = slugifyToolName(s.name, t.name);
      // Collision guard : if two servers expose the same slugged
      // name (very unlikely with the server prefix), append a digit.
      let unique = promptName;
      let n = 1;
      while (mcpRouteMap.has(unique)) {
        unique = (promptName.slice(0, 60) + '_' + ++n).slice(0, 64);
      }
      mcpRouteMap.set(unique, { server: s.name, tool: t.name });
      out.push({
        name: unique,
        description: (t.description ?? `MCP tool from server "${s.name}"`).slice(0, 1024),
        // The MCP spec uses `inputSchema` ; Anthropic uses
        // `input_schema`. They share the JSON Schema body. We don't
        // round-trip-validate here ; if a server emits a malformed
        // schema, Anthropic will reject the request and the user
        // sees a clear API error.
        input_schema: { type: 'object', properties: {} },
      });
    }
  }
  // Second pass : enrich with real schemas. The current IPC list-tools
  // endpoint only returns name+description+server — the input_schema
  // sits in the per-server discovered tools cache (main process).
  // Future polish : extend the IPC to surface inputSchema. For now
  // every MCP tool gets a permissive default schema and the model
  // can still fill in arguments.
  return out;
}

/** Route a tool_use block whose name starts with `mcp_` to the
 *  underlying server.tool via window.suxai.mcp.callTool. Returns a
 *  string suitable for the agent's tool_result content. */
export async function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const route = mcpRouteMap.get(toolName);
  if (!route) {
    return { ok: false, error: `Unknown MCP tool "${toolName}". The route map is rebuilt at the start of each agent turn — was the server disconnected?` };
  }
  const res = await callTool(route.server, route.tool, args);
  if (!res.ok) return { ok: false, error: res.error };
  // MCP tool responses follow the spec : { content: [{ type, text|...}], isError? }
  // We squash to a single string for the agent's tool_result.
  const result = res.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  let text = '';
  if (Array.isArray(result?.content)) {
    text = result.content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n');
  } else {
    text = JSON.stringify(result, null, 2).slice(0, 16_000);
  }
  if (result?.isError) {
    return { ok: false, error: text || 'MCP tool reported an error' };
  }
  return { ok: true, content: text || '(empty result)' };
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp_');
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
