import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { streamAi, buildCommandPrompt, countTokens, type AiCommand } from '../../api/quatarly';
import { AI_MODELS, DEFAULT_MODEL_ID } from '../../config';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Message, type ChatMessage, type ToolCallSnapshot } from './Message';
import { ModelSelector } from './ModelSelector';
import { ConversationSwitcher } from './ConversationSwitcher';
import { ApprovalDialog, type ApprovalRequest } from './ApprovalDialog';
import { onAiCommand } from '../../lib/commands';
import { useSettings } from '../../lib/settings';
import { loadMemories, formatMemories, addMemory, deleteMemory, extractMemoriesFromTranscript } from '../../lib/memories';
import {
  emptyConversation,
  deriveTitle,
  loadConversations,
  saveConversations,
  type Conversation,
} from '../../lib/conversations';
import { executeTool, toolsForMode, type ToolCall } from '../../lib/agent';
import { buildAgentToolDefinitions, executeMcpTool, isMcpToolName } from '../../lib/mcp';
import { buildAdditionalDataXml } from '../../lib/additional-data';
import { buildRepoMap, formatRepoMapBlock } from '../../lib/repo-map';
import { TokenUsageBar } from './TokenUsageBar';
import type { AgentMessage, AgentContentBlock } from '../../api/quatarly';
import { useToast } from '../ui/Toast';
import { AtelierIcon } from '../ui/AtelierIcon';
import './AIPanel.css';

const STORAGE_MODEL_KEY = 'suxai.model';
const MAX_PERSISTED_MESSAGES = 200;

/** Pull the first fenced code block out of a streamed response. */
function extractFirstCodeBlock(text: string): string | null {
  const m = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  return m ? m[1] : null;
}

/**
 * Hard cap for inlined attachments (paperclip / drag-drop). v0.11.1
 * raises this to 7 MB — the server's per-block schema cap moved to
 * 8 MB so we keep ~1 MB of headroom for the message envelope and
 * other context. Anything bigger gets sliced with a "[truncated —
 * N more bytes]" footer so the model sees the boundary explicitly.
 * Mirrors the read_file truncation policy.
 */
const ATTACHMENT_HARD_CAP = 7_000_000; // 7 MB
const ATTACHMENT_WARN_THRESHOLD = 2_000_000; // 2 MB

function adjustOversizedAttachment(
  content: string,
  name: string,
  toast: { info: (t: string, d?: string) => void },
): string {
  if (content.length <= ATTACHMENT_HARD_CAP) {
    if (content.length >= ATTACHMENT_WARN_THRESHOLD) {
      const mb = (content.length / 1_000_000).toFixed(2);
      toast.info(
        `${name} attached (${mb} MB)`,
        'Big files cost more tokens — the AI will see the whole content.',
      );
    }
    return content;
  }
  const kept = content.slice(0, ATTACHMENT_HARD_CAP);
  const dropped = content.length - ATTACHMENT_HARD_CAP;
  toast.info(
    `${name} truncated`,
    `${(content.length / 1_000_000).toFixed(2)} MB → kept first ${(ATTACHMENT_HARD_CAP / 1_000_000).toFixed(1)} MB. ` +
      `Use the read_file tool from the agent to inspect specific ranges if needed.`,
  );
  return (
    kept +
    `\n\n[truncated — ${dropped} more bytes (${(dropped / 1_000_000).toFixed(2)} MB) not shown]`
  );
}

function modelProviderForId(id: string): 'anthropic' | 'openai' | undefined {
  return AI_MODELS.find((m) => m.id === id)?.provider;
}

const MAX_AGENT_ITERATIONS = 10;

/**
 * JSON.stringify with sorted keys — used to compute a stable signature
 * of a tool call's arguments for loop detection. Object key order is
 * insertion-dependent in JS, so a naive JSON.stringify can give two
 * different strings for the same conceptual payload.
 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, function (_key, v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (seen.has(v as object)) return '[circular]';
      seen.add(v as object);
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/**
 * Convert the panel's ChatMessage list into Anthropic agent-shaped
 * messages: assistant turns become block arrays of text + tool_use,
 * tool calls with results spawn synthetic user turns of tool_result
 * blocks. Untouched chat messages stay flat strings.
 */
function chatToAgentMessages(messages: ChatMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.historyContent ?? m.content });
      continue;
    }
    // assistant — only emit tool_use blocks that have a matching result.
    // A pending/running tool_use without a corresponding tool_result on
    // the next turn is rejected by Anthropic ("400 tool_use_id ... has
    // no tool_result"). We drop those blocks entirely; the model will
    // re-issue them in the next iteration if it still wants them.
    const totalToolCalls = m.toolCalls?.length ?? 0;
    const completed = (m.toolCalls ?? []).filter(
      (tc) => tc.result !== undefined && tc.status !== 'pending' && tc.status !== 'running',
    );
    // v3.14 hotfix — si le message a des tool calls dont au moins un
    // est encore pending/running (race condition : nouveau streamAi
    // déclenché avant la fin d'exécution des tools, ou interruption
    // partielle), drop le message ENTIER. Émettre seulement le texte
    // produit un trailing assistant qui fait 400 « assistant prefill ».
    // Émettre seulement les tools complétés produit une asymétrie
    // tool_use ↔ tool_result que Anthropic rejette aussi. Drop est
    // safe : le modèle re-stratégisera au prochain tour, vu qu'il ne
    // « voit » plus avoir émis ces tool_uses.
    if (totalToolCalls > 0 && completed.length < totalToolCalls) {
      continue;
    }
    const blocks: AgentContentBlock[] = [];
    // v0.12: thinking / redacted_thinking / server_tool_use blocks
    // come FIRST in the assistant message — this is required by
    // Anthropic on *-thinking models. The cryptographic signature on
    // each thinking block is part of the chain: drop or reorder it
    // and the next request fails with 400.
    if (m.assistantBlocks && m.assistantBlocks.length > 0) {
      for (const b of m.assistantBlocks) blocks.push(b);
    }
    if (m.content && m.content.trim()) {
      blocks.push({ type: 'text', text: m.content });
    }
    for (const tc of completed) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }
    if (blocks.length > 0) {
      out.push({ role: 'assistant', content: blocks });
    }
    if (completed.length > 0) {
      out.push({
        role: 'user',
        content: completed.map((tc) => ({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: tc.result!,
          is_error: tc.status === 'error',
        })),
      });
    }
  }
  return out;
}

// Cap the agent transcript at MAX_AGENT_MESSAGES while preserving
// tool_use ↔ tool_result pair invariants. Anthropic rejects (400)
// any transcript where:
//   - an assistant turn emits tool_use_id `X` but no subsequent
//     user turn contains a tool_result with that id, OR
//   - a user turn emits tool_result for an id that has no preceding
//     tool_use in the assistant transcript.
//
// v0.11.5 fix: previously the trimmer only walked forward past
// tool_result-only USER messages. If the naive cut landed on an
// ASSISTANT message containing a tool_use whose tool_result lived
// in messages[cut-1] (already dropped), the transcript ended up
// with an orphan tool_use → guaranteed 400 next request.
//
// New strategy: find the latest "safe" cut by walking forward from
// the naive cut to the next user message that is NOT a tool_result-
// only synthetic turn (i.e. a real user query OR an assistant turn
// whose tool history ends cleanly inside the kept window).
//
// Safe boundaries:
//   - cut === messages.length (nothing to keep — give up trimming;
//     /compact will handle it on the next turn)
//   - messages[cut] is a user turn with string content
//   - messages[cut] is a user turn whose content array contains at
//     least one non-tool_result block (regular user query)
//   - messages[cut] is an assistant turn (tool_use ids in
//     messages[<cut] are dropped along with their results — clean cut)
const MAX_AGENT_MESSAGES = 40;
function trimAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= MAX_AGENT_MESSAGES) return messages;
  const first = messages[0];
  let cut = messages.length - MAX_AGENT_MESSAGES;

  const isSafeCut = (m: AgentMessage): boolean => {
    // String content user message → safe (a user query).
    if (m.role === 'user' && typeof m.content === 'string') return true;
    if (m.role === 'user' && Array.isArray(m.content)) {
      // Tool_result-only user turn = synthetic response to a prior
      // assistant's tool_use → NOT safe (cutting here orphans the
      // previous assistant's tool_use).
      const hasNonToolResult = m.content.some(
        (b) => (b as { type?: string }).type !== 'tool_result',
      );
      return hasNonToolResult;
    }
    // Assistant message → safe to start fresh from here. Anything
    // before is dropped wholesale, including unmatched tool_uses.
    return m.role === 'assistant';
  };

  while (cut < messages.length && !isSafeCut(messages[cut])) {
    cut++;
  }

  if (cut >= messages.length) {
    // No safe cut found within the trim window. Refuse to trim this
    // turn — better to send a slightly oversized transcript than a
    // 400-prone one. /compact (auto-triggered at 70 % context) will
    // reset the conversation cleanly next time.
    return messages;
  }

  const tail = messages.slice(cut);
  // Re-prepend the original opening message so the model still sees
  // task framing. Skip the dup if the cut landed exactly on first.
  if (tail.length > 0 && first === tail[0]) return tail;
  return [first, ...tail];
}

interface AgentLoopArgs {
  token: string;
  modelId: string;
  /** Operating mode: composer (full agent) or ask (Plan mode, read-only
   *  + create_plan). Drives both the tools array we send and the
   *  system-prompt suffix selected upstream. */
  mode: 'composer' | 'ask';
  /** Workspace root, passed through to executeTool so plan-mode-only
   *  tools can scope their writes to <workspace>/.suxai/. */
  workspaceRoot: string | null;
  firstUserMsg: ChatMessage;
  firstAssistantMsg: ChatMessage;
  /** Snapshot of all messages including the first user + first assistant. */
  conversationMessages: ChatMessage[];
  /**
   * Optional preamble injected as the very first user turn on every
   * agent iteration — used for AGENTS.md / CLAUDE.md project guidance
   * the user wants the model to keep in mind across the conversation.
   * Empty string means no preamble.
   */
  preamble?: string;
  setMessages: (
    updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void;
  setStreaming: (v: boolean) => void;
  abortRef: React.MutableRefObject<(() => void) | null>;
  toast: { info: (t: string, d?: string) => void; error: (t: string, d?: string) => void };
  requestApproval: (
    call: ToolCall,
    preview?: { path: string; original: string; proposed: string },
  ) => Promise<import('../../lib/agent').ApproveResult>;
  /** Bridge for the apply_lazy_edit tool — POSTs to /ai/apply on the
   *  VPS, returns the merged file content or null on failure. */
  applyLazyEdit?: (input: {
    path: string;
    original: string;
    lazy_edit: string;
    instruction?: string;
  }) => Promise<string | null>;
  /** v0.13.2 — current approval mode (auto/step/yolo). Read fresh
   *  per turn via this getter so a mid-run setting change takes
   *  effect on the next batch. In `step` mode, every non-write
   *  tool also requires explicit user approval (defeats the purpose
   *  of parallelism but useful for paranoid debugging or first runs
   *  on a sensitive codebase). */
  getApprovalMode?: () => 'auto' | 'step' | 'yolo';
}

async function runAgentLoop(args: AgentLoopArgs): Promise<void> {
  const { token, modelId, firstAssistantMsg, conversationMessages, setMessages, setStreaming, abortRef, toast } = args;

  let currentAssistantId = firstAssistantMsg.id;
  // Working copy of the conversation messages — mirrors what we'll push
  // to the panel's state. Built from the initial snapshot, then we
  // reflect every state mutation locally so chatToAgentMessages always
  // sees the freshest payload.
  let working = conversationMessages.slice();

  // v0.16.13 — fetch MCP tools once at the top of the agent loop and
  // merge them into the per-turn tools array. Servers rarely flip
  // mid-conversation ; if the user adds one via Settings the next
  // turn will pick it up (re-fetched on every runAgentLoop call).
  // The route map (server, toolName) is rebuilt as a side effect so
  // executeMcpTool can route the call back correctly.
  let mcpToolDefs: Awaited<ReturnType<typeof buildAgentToolDefinitions>> = [];
  try { mcpToolDefs = await buildAgentToolDefinitions(); }
  catch { /* MCP not available — agent runs without those tools */ }

  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    // The streaming assistant message is the one we don't want to send
    // back as part of the prompt — we exclude it from the agent
    // messages we forward to the model.
    const sent = working.filter((m) => m.id !== currentAssistantId);
    const baseMessages = chatToAgentMessages(sent);
    const trimmed = trimAgentMessages(baseMessages);
    // Prepend AGENTS.md/CLAUDE.md preamble (if any) as a synthetic
    // first user turn. Anthropic's caching keys on prefix bytes — keep
    // this preamble identical across iterations to maximise cache hits.
    const agentMessages: AgentMessage[] = args.preamble
      ? [{ role: 'user', content: args.preamble }, ...trimmed]
      : trimmed;

    let stopReason = '';
    const collectedTools: ToolCall[] = [];

    // v2.0.1 FIX — bug « tourne en boucle ». If the stream rejects
    // mid-stream (network error, abort, etc) AFTER onToolUse has fired
    // but BEFORE we get to execute the tool, the tool sits at status
    // 'pending' forever. chatToAgentMessages then filters it out (line
    // ~127) and the model sees the conversation as if no tool_use ever
    // happened → re-emits the same tool_use → if the network errors
    // again, more pending tools stack up → infinite loop. We must NOT
    // let pending tools survive a stream rejection : convert them to a
    // synthetic error result so the model sees « I called list_dir, it
    // failed, I should adapt » on the next iteration. This also unsticks
    // the loop-detection (which counts tool calls in `working`).
    let streamSucceeded = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = streamAi(
          token,
          {
            modelId,
            command: 'chat',
            prompt: '',
            tools: [...toolsForMode(args.mode), ...mcpToolDefs],
            agentMessages,
            mode: args.mode,
          },
          {
            onToken: (chunk) => {
              setMessages((m) => {
                const next = m.map((msg) =>
                  msg.id === currentAssistantId
                    ? { ...msg, content: msg.content + chunk }
                    : msg,
                );
                working = next;
                return next;
              });
            },
            onToolUse: (call) => {
              collectedTools.push(call);
              const snapshot: ToolCallSnapshot = {
                id: call.id,
                name: call.name,
                input: call.input,
                status: 'pending',
              };
              setMessages((m) => {
                const next = m.map((msg) =>
                  msg.id === currentAssistantId
                    ? { ...msg, toolCalls: [...(msg.toolCalls ?? []), snapshot] }
                    : msg,
                );
                working = next;
                return next;
              });
            },
            onThinkingBlock: (block) => {
              setMessages((m) => {
                const next = m.map((msg) =>
                  msg.id === currentAssistantId
                    ? { ...msg, assistantBlocks: [...(msg.assistantBlocks ?? []), block] }
                    : msg,
                );
                working = next;
                return next;
              });
            },
            onRedactedThinking: (block) => {
              setMessages((m) => {
                const next = m.map((msg) =>
                  msg.id === currentAssistantId
                    ? { ...msg, assistantBlocks: [...(msg.assistantBlocks ?? []), block] }
                    : msg,
                );
                working = next;
                return next;
              });
            },
            onServerToolUse: (block) => {
              setMessages((m) => {
                const next = m.map((msg) =>
                  msg.id === currentAssistantId
                    ? { ...msg, assistantBlocks: [...(msg.assistantBlocks ?? []), block] }
                    : msg,
                );
                working = next;
                return next;
              });
            },
            onStop: (reason) => {
              stopReason = reason;
            },
            onDone: () => {
              setMessages((m) => {
                const next = m.map((msg) =>
                  msg.id === currentAssistantId ? { ...msg, streaming: false } : msg,
                );
                working = next;
                return next;
              });
              resolve();
            },
            onError: (err) => reject(err),
          },
        );
        abortRef.current = cancel;
      });
      streamSucceeded = true;
    } catch (err) {
      // Stream errored. If onToolUse fired before the failure, those
      // tool calls are pending. Flip them to error with a synthetic
      // result so the next iteration carries the failure forward AND
      // the model can change strategy. Then re-throw to the outer
      // .catch which clears streaming + surfaces the error to the user.
      if (collectedTools.length > 0) {
        const errMsg = (err as Error).message || 'stream error';
        setMessages((m) => {
          const next = m.map((msg) => {
            if (msg.id !== currentAssistantId) return msg;
            return {
              ...msg,
              toolCalls: msg.toolCalls?.map((tc) =>
                collectedTools.some((c) => c.id === tc.id) && tc.status === 'pending'
                  ? {
                      ...tc,
                      status: 'error' as const,
                      result: `Stream interrupted before tool ran: ${errMsg}. Adapt — try a different approach.`,
                    }
                  : tc,
              ),
              streaming: false,
            };
          });
          working = next;
          return next;
        });
      }
      throw err;
    }
    if (!streamSucceeded) {
      // unreachable — kept for type narrowing
      break;
    }

    // v0.11.10: handle every Anthropic stop_reason explicitly.
    //
    // - 'end_turn'          → break (the natural completion path)
    // - 'tool_use'          → execute tools then loop
    // - 'max_tokens'        → mark assistant message with a "truncated"
    //                          warning and break; the user can resend
    //                          to ask the model to continue
    // - 'pause_turn'        → continuing per Anthropic spec means
    //                          we send the assistant content back
    //                          verbatim; chatToAgentMessages already
    //                          round-trips it. Skip the tool-result
    //                          branch and keep the loop going.
    // - 'refusal'           → discard the offending turn; halt the
    //                          loop. The user sees the chat content
    //                          but the message is flagged so it
    //                          doesn't poison the next request.
    // - 'stop_sequence'     → like end_turn (we don't set custom
    //                          stop sequences yet, but be tolerant)
    // - any other string    → treat as end_turn for forward compat.
    if (stopReason === 'refusal') {
      // The model refused. Don't include the assistant message in
      // any follow-up — Anthropic specifies refusals must be
      // discarded before retry. We mark the bubble so the user sees
      // why their request didn't proceed.
      setMessages((m) =>
        m.map((msg) =>
          msg.id === currentAssistantId
            ? {
                ...msg,
                streaming: false,
                error: 'Le modèle a refusé cette requête. Reformule ou abandonne.',
              }
            : msg,
        ),
      );
      break;
    }
    if (stopReason === 'max_tokens') {
      // Model hit max_tokens. Don't loop (we'd just hit the same
      // wall on the next iteration). Surface the truncation so the
      // user knows why the answer ends abruptly.
      setMessages((m) =>
        m.map((msg) =>
          msg.id === currentAssistantId
            ? {
                ...msg,
                streaming: false,
                error: 'Réponse tronquée (max_tokens atteint). Relance pour faire continuer.',
              }
            : msg,
        ),
      );
      break;
    }
    if (stopReason === 'model_context_window_exceeded') {
      // v0.12.3 (audit #18): Sonnet/Opus 4.x emit this when the
      // request itself overflows the context window. Looping would
      // hit the same wall — surface a clear actionable error so the
      // user can /compact or pick a bigger model.
      setMessages((m) =>
        m.map((msg) =>
          msg.id === currentAssistantId
            ? {
                ...msg,
                streaming: false,
                error: 'Contexte saturé. Lance /compact ou choisis un modèle à plus large fenêtre (Opus 4.6 thinking).',
              }
            : msg,
        ),
      );
      break;
    }
    // v0.12.10 hotfix: previous pause_turn handler created an infinite
    // loop. When the model emitted client tool_use blocks AND a
    // pause_turn stop_reason on the same turn (rare but does happen),
    // the old handler spawned a fresh assistant message and `continue`-d
    // WITHOUT executing the pending tool_use calls. Those tool calls
    // sat in 'pending' (UI: QUEUED) forever, the next turn re-emitted
    // similar tool_use, and the loop never terminated.
    //
    // New strategy: if there are tools to run, fall through to the
    // tool execution block (same as stop_reason === 'tool_use'). If
    // there are NO tools, treat pause_turn as end_turn — break the
    // loop and let the user reply to nudge the model forward. This
    // matches Anthropic's spec: pause_turn is "the model paused, send
    // the assistant content back to continue" — we already round-trip
    // assistantBlocks via chatToAgentMessages on the next user turn.
    if (stopReason === 'pause_turn' && collectedTools.length === 0) {
      break;
    }
    if (
      collectedTools.length === 0 ||
      (stopReason !== 'tool_use' && stopReason !== 'pause_turn')
    ) {
      // Conversation ended naturally (end_turn / stop_sequence /
      // unknown future reason — treat as end_turn for forward compat).
      break;
    }

    // Execute each tool call with status updates.
    // Tool calls in the same assistant turn run in PARALLEL — the
    // model emits them as one batch and Anthropic expects all
    // tool_results back in one user turn anyway. Sequential execution
    // wastes wall time when read_file + read_file + grep arrive together.
    //
    // Approval prompts are awaited inside executeTool, so two parallel
    // edits will pop two approval dialogs back-to-back rather than
    // showing them simultaneously (the ApprovalDialog itself is a
    // single-instance component). That's intentional — concurrent
    // approval UI would be confusing.
    //
    // Mark every call running first (so the UI shows the right state
    // for each card), then Promise.all the executions, then write back
    // all results in a single setMessages update.
    setMessages((m) => {
      const next = m.map((msg) =>
        msg.id === currentAssistantId
          ? {
              ...msg,
              toolCalls: msg.toolCalls?.map((tc) =>
                collectedTools.some((c) => c.id === tc.id)
                  ? { ...tc, status: 'running' as const }
                  : tc,
              ),
            }
          : msg,
      );
      working = next;
      return next;
    });

    // Loop detection: if the same (name, sortedInput) appears 3 times in
    // a row across recent assistant turns, short-circuit with a synthetic
    // error result so the model has to change strategy.
    const repeatKey = (c: ToolCall): string =>
      `${c.name}::${stableStringify(c.input)}`;
    const recentKeys = working
      .filter((m) => m.role === 'assistant' && m.toolCalls)
      .flatMap((m) => m.toolCalls!.map(repeatKey))
      .slice(-6); // last 6 tool calls across the conversation

    type ExecOutcome = {
      call: ToolCall;
      result: { content: string; is_error?: boolean; tool_use_id: string };
      status: ToolCallSnapshot['status'];
    };

    // v0.12.12 — fresh per-turn map of path locks. Threaded into every
    // executeTool call so parallel edit_file/write_file on the same
    // path serialise rather than race. Critical for data-integrity:
    // without it, edit N silently overwrites edits 1..N-1 (their
    // changes vanish from disk after the user accepts the cascade
    // of diffs).
    const pathLocks = new Map<string, Promise<unknown>>();

    const outcomes: ExecOutcome[] = await Promise.all(
      collectedTools.map(async (call): Promise<ExecOutcome> => {
        const key = repeatKey(call);
        const sameRunCount = recentKeys.filter((k) => k === key).length;
        if (sameRunCount >= 3) {
          return {
            call,
            result: {
              tool_use_id: call.id,
              content:
                `Loop detected: this exact tool call ran ${sameRunCount} times ` +
                `with the same arguments. Change strategy — try different inputs, ` +
                `read different files, or ask the user for clarification.`,
              is_error: true,
            },
            status: 'error',
          };
        }
        // v0.13.2 — step mode: prompt the user for EVERY non-write
        // tool. Write tools (edit_file/write_file) already require
        // explicit accept via the inline diff, so adding a second
        // prompt would just be noise.
        const mode = args.getApprovalMode?.() ?? 'auto';
        const isWrite = call.name === 'edit_file' || call.name === 'write_file';
        if (mode === 'step' && !isWrite) {
          const stepOk = await args.requestApproval(call);
          if (!stepOk.ok) {
            return {
              call,
              result: {
                tool_use_id: call.id,
                content: `User skipped ${call.name} in step mode.`,
                is_error: false,
              },
              status: 'rejected',
            };
          }
        }
        try {
          let result;
          if (isMcpToolName(call.name)) {
            // v0.16.13 — route MCP tool calls through the dedicated
            // executor. The user-approval flow still gates these via
            // requestApproval (modal) since MCP tools can have any
            // side effect — only YOLO mode auto-approves them, and
            // even then we let the request through (parity with
            // other non-file-write tools).
            const approval = await args.requestApproval(call);
            const ok = (approval as { ok: boolean }).ok ?? false;
            if (!ok) {
              result = {
                tool_use_id: call.id,
                content: `User rejected MCP tool ${call.name}.`,
                is_error: false,
              };
            } else {
              const mcpRes = await executeMcpTool(
                call.name,
                (call.input as Record<string, unknown>) ?? {},
              );
              if (mcpRes.ok) {
                result = {
                  tool_use_id: call.id,
                  content: mcpRes.content,
                  is_error: false,
                };
              } else {
                result = {
                  tool_use_id: call.id,
                  content: mcpRes.error,
                  is_error: true,
                };
              }
            }
          } else {
            result = await executeTool(call, {
              approve: (c, preview) => args.requestApproval(c, preview),
              workspaceRoot: args.workspaceRoot ?? null,
              applyLazyEdit: args.applyLazyEdit,
              pathLocks,
              notifyEdit: ({ path, added, removed, partial }) => {
                const name = path.split(/[\\/]/).pop() ?? path;
                toast.info(
                  `Edited ${name}`,
                  `+${added} −${removed} lines${partial ? ' (partial)' : ''}`,
                );
              },
            });
          }
          const status: ToolCallSnapshot['status'] = result.is_error
            ? 'error'
            : typeof result.content === 'string' &&
              result.content.startsWith('User rejected')
            ? 'rejected'
            : 'done';
          return { call, result, status };
        } catch (err) {
          return {
            call,
            result: {
              tool_use_id: call.id,
              content: `Tool threw: ${(err as Error).message}`,
              is_error: true,
            },
            status: 'error',
          };
        }
      }),
    );

    setMessages((m) => {
      const next = m.map((msg) =>
        msg.id === currentAssistantId
          ? {
              ...msg,
              toolCalls: msg.toolCalls?.map((tc) => {
                const out = outcomes.find((o) => o.call.id === tc.id);
                return out
                  ? { ...tc, status: out.status, result: out.result.content }
                  : tc;
              }),
            }
          : msg,
      );
      working = next;
      return next;
    });

    // Spawn a fresh assistant message for the next iteration.
    const next: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      streaming: true,
      modelId,
    };
    setMessages((m) => {
      const updated = [...m, next];
      working = updated;
      return updated;
    });
    currentAssistantId = next.id;
  }

  // If we exited because of MAX_AGENT_ITERATIONS, ensure the streaming
  // flag clears.
  setMessages((m) =>
    m.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)),
  );
  setStreaming(false);
  abortRef.current = null;
  toast.info('Agent finished');
}

/**
 * Read project guidance — AGENTS.md takes precedence over CLAUDE.md
 * because it's the cross-vendor standard. We only search the
 * workspace root (not the active file's directory) so the preamble
 * stays stable across file switches — Anthropic's prompt cache keys
 * on prefix bytes, and a varying preamble would shred the cache.
 */
async function loadProjectPreamble(
  workspaceRoot: string | null,
): Promise<string> {
  const roots: string[] = [];
  if (workspaceRoot) roots.push(workspaceRoot);
  for (const root of roots) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
      const candidate = `${root}${root.endsWith(sep) ? '' : sep}${name}`;
      try {
        const f = await window.suxai.fs.readFile(candidate);
        if (f.content.trim().length > 0) {
          // Cap at 16k chars — large project READMEs would otherwise
          // dominate the cache prefix.
          const body = f.content.length > 16_000
            ? f.content.slice(0, 16_000) + '\n\n[truncated AGENTS.md — load full file with read_file if needed]'
            : f.content;
          return (
            `# Project guidance (${candidate})\n\n` +
            body +
            '\n\n---\n\n' +
            'The text above is automatic project context loaded by SUXAI from the ' +
            'workspace AGENTS.md/CLAUDE.md. Use it as background; the user message ' +
            'that follows is the actual task.'
          );
        }
      } catch {
        /* file missing — try the next candidate */
      }
    }
  }
  return '';
}

export function AIPanel() {
  const { token } = useAuth();
  const { activeFile, selection, openDiff, openFile, openFiles, workspaceRoot, editorContext } = useWorkspace();
  // Cache the loaded preamble per workspaceRoot so we read AGENTS.md
  // once per workspace open — not on every send.
  const preambleRef = useRef<{ root: string | null; preamble: string } | null>(null);
  const [modelId, setModelId] = useState<string>(() => {
    return localStorage.getItem(STORAGE_MODEL_KEY) || DEFAULT_MODEL_ID;
  });
  const [input, setInput] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [attachments, setAttachments] = useState<{ path: string; content: string; name: string }[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // v0.13.0 — read approval mode from settings (auto/step/yolo).
  // Defaults to 'auto' to preserve current behaviour for existing users.
  const [appSettings] = useSettings();
  const approvalModeRef = useRef(appSettings.approvalMode);
  useEffect(() => { approvalModeRef.current = appSettings.approvalMode; }, [appSettings.approvalMode]);
  // v0.13.4 — track which conversations have already had a memory
  // extraction run, so we don't re-bill Haiku on every turn. Once
  // extracted per conv, the user has to /reset or /clear to retry.
  const memoryExtractedRef = useRef<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Custom slash commands loaded from <workspace>/.suxai/commands/.
  // Refreshed on workspace change. Empty when no workspace open or
  // no command files present (the directory is optional).
  const [customCommands, setCustomCommands] = useState<
    Array<{ name: string; description?: string; mode?: 'composer' | 'ask'; body: string }>
  >([]);
  useEffect(() => {
    if (!workspaceRoot || !window.suxai.commands?.list) {
      setCustomCommands([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await window.suxai.commands.list(workspaceRoot);
        if (cancelled) return;
        setCustomCommands(list);
      } catch (err) {
        console.warn('[commands] list failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceRoot]);

  // Approval flow:
  //   • edit_file / write_file with a preview → open the InlineDiff
  //     directly in the editor so the user can accept/reject hunks
  //     individually (Cursor-style). The diff persists the file and
  //     reports `written: true` back to the agent so we don't double-
  //     write the model's full proposed text.
  //   • Everything else (run_command, no-preview cases) → fall back
  //     to the legacy ApprovalDialog modal.
  const requestApproval = useCallback(
    (
      call: ToolCall,
      preview?: { path: string; original: string; proposed: string },
    ): Promise<import('../../lib/agent').ApproveResult> =>
      new Promise((resolve) => {
        // v0.13.0 — yolo mode: auto-approve any tool whose underlying
        // safety check has already passed (DANGER_PATTERNS catches
        // the truly dangerous shell commands BEFORE this hook fires
        // for run_command, so reaching here means it's already vetted).
        // File writes still go through the inline diff so the user
        // sees what changed and can roll back.
        const mode = approvalModeRef.current;
        const isFileWrite = call.name === 'edit_file' || call.name === 'write_file';
        if (mode === 'yolo' && !isFileWrite) {
          resolve({ ok: true });
          return;
        }
        if (isFileWrite && preview) {
          let settled = false;
          const settle = (
            ok: boolean,
            written: boolean,
            finalContent?: string,
          ) => {
            if (settled) return;
            settled = true;
            resolve({ ok, written, finalContent });
          };
          openDiff({
            path: preview.path,
            original: preview.original,
            proposed: preview.proposed,
            label: call.name === 'edit_file' ? 'edit · agent' : 'write · agent',
            // InlineDiff calls onResolve(true, finalText) on Accept
            // (after writing to disk itself) or (false) on Reject.
            onResolve: (accepted, finalContent) => {
              if (accepted) settle(true, true, finalContent ?? preview.proposed);
              else settle(false, false);
            },
          });
          return;
        }
        // Modal approval for run_command and any other tool that
        // can't be visualised as a file diff.
        setApproval({
          call,
          preview,
          resolve: (approved) => {
            setApproval(null);
            resolve({ ok: approved });
          },
        });
      }),
    // openDiff is a stable callback from WorkspaceContext.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Mirror of `attachments` state — read by sendCommand via ref so a
  // regenerate call that just set attachments via setAttachments() sees
  // the new value on the next tick (closure would otherwise hold the
  // previous array).
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Grow the composer with the typed content, capped so it never eats
  // the whole panel.
  const autoResize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 240);
    el.style.height = `${Math.max(40, next)}px`;
  }, []);

  useEffect(() => {
    // Reset height when the input is cleared programmatically (after send).
    if (textareaRef.current && input === '') {
      textareaRef.current.style.height = '';
    }
  }, [input]);
  const toast = useToast();

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeConvId) ?? null,
    [conversations, activeConvId],
  );
  const messages = activeConv?.messages ?? [];

  // Approaching-context-limit warning. Heuristic: 4 chars ≈ 1 token,
  // 200K token window for Sonnet/Opus 4.x → warn around 140K tokens
  // (≈ 560K chars across all messages). Fires once per threshold
  // crossing thanks to the ref guard so the user isn't spammed.
  const warnedAtRef = useRef<number>(0);
  // v0.12.4 (audit #17): timestamp of the last successful compaction.
  // Read by compactConversation to short-circuit a re-trigger that
  // would loop on a still-saturated context.
  const lastCompactAtRef = useRef<number>(0);
  // v0.12.8: cache the most recent count_tokens response so we don't
  // re-query Anthropic on every state change. Refreshed only when the
  // heuristic crosses 80 % of the warn threshold AND the cache is
  // older than 30 s. Cleared on conversation switch.
  const tokenCountRef = useRef<{ convId: string; tokens: number; at: number } | null>(null);
  useEffect(() => {
    if (!activeConv) return;
    const totalChars = activeConv.messages.reduce(
      (acc, m) => acc + (m.historyContent?.length ?? m.content.length),
      0,
    );
    const approxTokens = Math.round(totalChars / 4);
    // v0.12.5 (audit #9): per-model context window. Anthropic Claude
    // 4.x ships at 200K input across Sonnet / Opus / Haiku. The map
    // exists so a future 1M-token beta model can be wired in without
    // touching the loop logic. Unknown IDs fall back to 200K.
    const ctxByModel: Record<string, number> = {
      'claude-opus-4-6-thinking': 200_000,
      'claude-sonnet-4-6-thinking': 200_000,
      'claude-haiku-4-5-20251001': 200_000,
    };
    const ctxWindow = ctxByModel[modelId] ?? 200_000;
    const WARN_AT = Math.floor(ctxWindow * 0.7);

    // Pick the best estimate available: cached server measurement
    // (same conv, < 60 s old) wins over the heuristic. The fetch
    // below refreshes the cache when we approach the threshold.
    const cached = tokenCountRef.current;
    const cachedFresh =
      cached && cached.convId === activeConv.id && Date.now() - cached.at < 60_000;
    const tokens = cachedFresh ? cached.tokens : approxTokens;

    if (tokens > WARN_AT && warnedAtRef.current < WARN_AT) {
      warnedAtRef.current = tokens;
      toast.info(
        `Conversation getting long (~${Math.round(tokens / 1000)}K tokens)`,
        'Type /compact to summarise older messages and free up context.',
      );
    }
    if (tokens < WARN_AT * 0.8) warnedAtRef.current = 0;

    // v0.12.8: refresh the real token count only when the heuristic
    // says we're approaching the threshold AND the cache is stale.
    // Anthropic bills count_tokens as input — keep the call rate low.
    const provider = modelProviderForId(modelId);
    if (
      provider === 'anthropic' &&
      token &&
      approxTokens > WARN_AT * 0.8 &&
      (!cached || cached.convId !== activeConv.id || Date.now() - cached.at > 30_000)
    ) {
      const convId = activeConv.id;
      // Build a representative messages array — the same one the
      // agent loop would send. We don't pass tools because tools-
      // only counting on a non-agent chat would skew estimates.
      const baseMessages = chatToAgentMessages(activeConv.messages);
      const trimmed = trimAgentMessages(baseMessages);
      countTokens(token, modelId, trimmed).then((real) => {
        if (real == null) return;
        // Conv may have changed by the time the response lands;
        // discard stale results.
        if (tokenCountRef.current && tokenCountRef.current.convId !== convId) return;
        tokenCountRef.current = { convId, tokens: real, at: Date.now() };
      }).catch(() => { /* network failure — heuristic stays */ });
    }
  }, [activeConv, modelId, token, toast]);

  // Mutate the active conversation's messages array.
  const setMessages = useCallback(
    (
      updater:
        | ChatMessage[]
        | ((prev: ChatMessage[]) => ChatMessage[]),
    ) => {
      setConversations((list) =>
        list.map((c) => {
          if (c.id !== activeConvId) return c;
          const next = typeof updater === 'function' ? updater(c.messages) : updater;
          if (next === c.messages) return c;
          return {
            ...c,
            messages: next,
            updatedAt: new Date().toISOString(),
            // Auto-rename to the first user message if still on the
            // default placeholder.
            title:
              c.title === 'New conversation' || c.title === ''
                ? deriveTitle(next)
                : c.title,
          };
        }),
      );
    },
    [activeConvId],
  );

  const selectedModel = useMemo(
    () => AI_MODELS.find((m) => m.id === modelId) ?? AI_MODELS[0],
    [modelId],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_MODEL_KEY, modelId);
  }, [modelId]);

  // Load persisted conversation list once at mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await loadConversations();
      if (cancelled) return;
      // Drop any lingering streaming flag from the previous session.
      const cleaned = loaded.list.map((c) => ({
        ...c,
        messages: c.messages.map((m) => ({ ...m, streaming: false })),
      }));
      if (cleaned.length === 0) {
        const fresh = emptyConversation();
        setConversations([fresh]);
        setActiveConvId(fresh.id);
      } else {
        setConversations(cleaned);
        setActiveConvId(loaded.active ?? cleaned[0].id);
      }
      setHistoryLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on change (debounced). Cap each conversation's messages.
  useEffect(() => {
    if (!historyLoaded) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const trimmed = conversations.map((c) => ({
        ...c,
        messages: c.messages
          .slice(-MAX_PERSISTED_MESSAGES)
          .map((m) => ({ ...m, streaming: false })),
      }));
      void saveConversations({ version: 2, active: activeConvId, list: trimmed });
    }, 400);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [conversations, activeConvId, historyLoaded]);

  // Stick-to-bottom: only auto-scroll when the user is already near the
  // bottom. If they've scrolled up to read, leave them alone (Cursor
  // does this; pulling the user back to the latest token is jarring).
  const stickyRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Don't even consider "sticky" logic until the area actually
    // overflows. Prevents showJump flickering on the empty state.
    const overflows = el.scrollHeight > el.clientHeight + 40;
    if (!overflows) {
      stickyRef.current = true;
      setShowJump(false);
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 60;
    stickyRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      // Re-evaluate the jump button visibility when content grows.
      onMessagesScroll();
    }
  }, [messages, onMessagesScroll]);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickyRef.current = true;
    setShowJump(false);
  }, []);

  const parseSlashCommand = useCallback((raw: string): { cmd: AiCommand; rest: string } | null => {
    const m = raw.match(/^\/(explain|refactor|fix|optimize)\b\s*(.*)/is);
    if (!m) return null;
    return { cmd: m[1].toLowerCase() as AiCommand, rest: m[2].trim() };
  }, []);

  /**
   * Run a compaction pass: take all but the last 6 turns of the
   * active conversation, ask Haiku 4.5 (cheap + fast) to summarise
   * them into a single text block, and splice the result back into
   * the conversation as a synthetic system-tag message. The trailing
   * 6 turns stay verbatim so the model keeps fine-grained context
   * for follow-up edits.
   *
   * Auto-triggered via the >70% context heuristic OR manually via
   * the /compact slash command. Idempotent — calling twice in a row
   * just folds the latest tail into the existing summary.
   */
  const compactConversation = useCallback(async () => {
    if (!token || !activeConvId) return;
    // v0.12.4 (audit #17): thrashing guard. If a compaction ran in
    // the last 30 s, refuse to retrigger — otherwise a long file
    // re-opened right after compaction can immediately push us back
    // over WARN_AT and start an infinite cycle. Toast the user so
    // they know to /clear or pick a larger model.
    const now = Date.now();
    if (now - lastCompactAtRef.current < 30_000) {
      toast.info(
        'Compaction récente',
        'Une compaction a déjà eu lieu il y a moins de 30 s — passe en /clear ou choisis un modèle à plus large fenêtre si la conversation reste trop dense.',
      );
      return;
    }
    const conv = conversations.find((c) => c.id === activeConvId);
    if (!conv || conv.messages.length <= 8) return;
    const TAIL = 6; // keep the most recent 6 messages verbatim
    const tail = conv.messages.slice(-TAIL);
    const head = conv.messages.slice(0, -TAIL);
    if (head.length === 0) return;
    lastCompactAtRef.current = now;

    // Render the head as a compact transcript for the summarising
    // model. We trim attachments / tool dumps to stay under a
    // reasonable input size — the goal is a summary, not perfect
    // fidelity.
    const transcript = head
      .map((m) => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const body = m.content.slice(0, 4000);
        const tools =
          m.toolCalls && m.toolCalls.length > 0
            ? `\n[tools called: ${m.toolCalls
                .map((tc) => tc.name)
                .join(', ')}]`
            : '';
        return `${role}: ${body}${tools}`;
      })
      .join('\n\n---\n\n');

    setStreaming(true);
    let summary = '';
    await new Promise<void>((resolve) => {
      const cancel = streamAi(
        token,
        {
          // Force Haiku — it's cheap and fast for summarisation. If
          // not available the server's findModel would fall back to
          // the default; either way the summary quality is fine.
          modelId: 'claude-haiku-4-5-20251001',
          command: 'chat',
          prompt:
            'You are compacting a long developer-AI conversation to fit in a smaller context window. Produce ONE concise summary (≤ 800 words) that preserves: the user\'s overall task, file paths discussed, key decisions made, code snippets that may be referenced later, and the current state of any in-progress work. Drop redundancy, exploratory dead-ends, and verbose tool dumps. Output plain prose, no headings.\n\n--- TRANSCRIPT TO SUMMARISE ---\n' +
            transcript,
        },
        {
          onToken: (chunk) => {
            summary += chunk;
          },
          onDone: () => resolve(),
          onError: (err) => {
            toast.error('Compaction failed', err.message);
            resolve();
          },
        },
      );
      abortRef.current = cancel;
    });
    abortRef.current = null;
    setStreaming(false);
    if (!summary.trim()) {
      toast.error('Compaction produced an empty summary');
      return;
    }

    // Splice: drop the head, prepend a synthetic system-tag user
    // message containing the summary, keep the verbatim tail.
    const summaryMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: '<conversation_summary>',
      historyContent:
        '<conversation_summary>\n' +
        summary.trim() +
        '\n</conversation_summary>\n\n[The earlier conversation was compacted to free up the context window. Treat this summary as ground truth for any references to past decisions or files.]',
    };
    setMessages([summaryMessage, ...tail]);
    toast.success(
      `Compacted ${head.length} messages → 1 summary`,
      `${tail.length} most recent messages kept verbatim.`,
    );
  }, [token, activeConvId, conversations, setMessages, toast]);

  /**
   * `/init` workflow: walk the workspace, render the same repo map
   * we inject in agent preambles, then ask Haiku 4.5 to draft an
   * AGENTS.md file from it. The result lands in <workspace>/AGENTS.md
   * via the inline diff (so the user can accept hunk-by-hunk or
   * reject if they don't like the draft).
   *
   * Doesn't require Plan / Agent mode — runs as a one-off model call
   * with no tools. Cheap & fast (Haiku, ~5s end-to-end on a typical
   * repo).
   */
  const runInitWorkflow = useCallback(async () => {
    if (!token || !workspaceRoot) return;
    // Build the repo map fresh — don't reuse the cached preamble
    // because the user may want to /init right after switching
    // workspace.
    let repoMapText = '';
    try {
      repoMapText = await buildRepoMap({
        workspaceRoot,
        activeFilePath: activeFile?.path ?? null,
        openPaths: openFiles.map((f) => f.path),
        recentPaths: editorContext.recentlyViewedFiles,
        budgetTokens: 1500,
      });
    } catch (err) {
      console.warn('[init] repo map failed:', err);
    }
    // Also surface a few "important" files (top-level configs) that
    // the model can mention in AGENTS.md without us reading them.
    const importantHints: string[] = [];
    for (const candidate of [
      'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
      'CMakeLists.txt', 'build.gradle', 'pom.xml', 'tsconfig.json',
      'README.md', 'README', '.cursor/rules', 'AGENTS.md',
    ]) {
      try {
        const sep = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/';
        const candPath = `${workspaceRoot}${workspaceRoot.endsWith(sep) ? '' : sep}${candidate}`;
        const f = await window.suxai.fs.readFile(candPath);
        importantHints.push(`## ${candidate} (${f.content.length} bytes)\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``);
      } catch { /* file missing — fine */ }
    }

    const prompt =
      'You are generating an AGENTS.md file for a codebase. AGENTS.md ' +
      'is project guidance read by AI coding assistants on every turn ' +
      '— think of it as a CLAUDE.md / .cursorrules. Keep it concise ' +
      '(max 200 lines), specific, and actionable.\n\n' +
      'Cover at minimum:\n' +
      '  • What this project IS (one sentence) and what it does NOT do.\n' +
      '  • Tech stack (languages, frameworks, build tool).\n' +
      '  • How to build / test / run (exact commands).\n' +
      '  • Coding conventions worth knowing (style, naming, layout).\n' +
      '  • Files / directories that should NOT be edited (generated, vendored, etc.).\n' +
      '  • Anything weird about this repo that would catch an AI off-guard.\n\n' +
      'Write in plain English (or French if the project obviously is FR).\n' +
      'Output ONLY the markdown body, no fences, no preamble. Use proper ' +
      'markdown headings (##, ###) and bullets.\n\n' +
      '--- REPO MAP (top files by structural importance) ---\n' +
      (repoMapText || '(empty)') +
      '\n\n--- IMPORTANT FILES (verbatim excerpts) ---\n' +
      (importantHints.join('\n\n') || '(none found)');

    const proposalMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      command: 'chat',
      content: '/init — generate AGENTS.md',
    };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      streaming: true,
      modelId: 'claude-haiku-4-5-20251001',
    };
    setMessages((m) => [...m, proposalMsg, assistantMsg]);
    setStreaming(true);
    let full = '';
    await new Promise<void>((resolve) => {
      const cancel = streamAi(
        token,
        {
          modelId: 'claude-haiku-4-5-20251001',
          command: 'chat',
          prompt,
        },
        {
          onToken: (chunk) => {
            full += chunk;
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantMsg.id ? { ...msg, content: msg.content + chunk } : msg)),
            );
          },
          onDone: () => {
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantMsg.id ? { ...msg, streaming: false } : msg)),
            );
            resolve();
          },
          onError: (err) => {
            // v0.11.8: human-readable message when the upstream
            // stream was truncated mid-flight (network drop, idle
            // proxy timeout, Anthropic 529). The user can just
            // resend their message to retry; the heartbeat in
            // v0.11.7 made this much rarer but it's still possible
            // on flaky mobile networks.
            const code = (err as Error & { code?: string }).code;
            const friendly =
              code === 'STREAM_TRUNCATED'
                ? `Connexion interrompue avant la fin de la réponse — relance ta question pour reprendre. (${err.message})`
                : err.message;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantMsg.id
                  ? { ...msg, streaming: false, error: friendly }
                  : msg,
              ),
            );
            resolve();
          },
        },
      );
      abortRef.current = cancel;
    });
    abortRef.current = null;
    setStreaming(false);
    if (!full.trim()) return;

    // Open the generated AGENTS.md in the inline diff. If a real
    // AGENTS.md already exists, we diff against it; otherwise we
    // diff against an empty buffer so the user sees every line as
    // a green-add hunk.
    const sep = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/';
    const target = `${workspaceRoot}${workspaceRoot.endsWith(sep) ? '' : sep}AGENTS.md`;
    let original = '';
    try {
      const r = await window.suxai.fs.readFile(target);
      original = r.content;
    } catch { /* file doesn't exist yet — that's fine */ }
    openDiff({
      path: target,
      original,
      proposed: full.replace(/^```[a-zA-Z]*\n?|```\s*$/g, ''),
      label: '/init · agents.md',
    });
    toast.info(
      'AGENTS.md drafted',
      'Review and accept hunks in the editor. The file will land in your workspace root.',
    );
  }, [
    token, workspaceRoot, activeFile, openFiles, editorContext,
    openDiff, setMessages, toast,
  ]);

  /**
   * Built-in local slash commands. These don't go to the LLM — they
   * mutate local state (clear conversation, toggle plan mode, list
   * keybindings, etc.) similarly to Cursor's command palette but
   * triggered from the chat composer.
   *
   * Returns true when the input was handled locally (the caller
   * should clear the input and skip sending), false otherwise.
   */
  const handleBuiltinSlash = useCallback(
    (raw: string): boolean => {
      const m = raw.trim().match(/^\/(\w[\w-]*)\b\s*(.*)$/);
      if (!m) return false;
      const cmd = m[1].toLowerCase();
      const arg = m[2].trim();
      switch (cmd) {
        case 'clear': {
          // Reset the active conversation in place — same as the +
          // button but without losing the conversation slot.
          if (!activeConvId) return true;
          setConversations((list) =>
            list.map((c) =>
              c.id === activeConvId ? { ...c, messages: [], title: 'New conversation' } : c,
            ),
          );
          setInput('');
          toast.info('Conversation cleared');
          return true;
        }
        case 'help': {
          const customSection =
            customCommands.length > 0
              ? '\n\n**Custom commands** (from `.suxai/commands/*.md`):\n\n' +
                customCommands
                  .map(
                    (c) =>
                      `- \`/${c.name}\`${c.description ? ' — ' + c.description : ''}` +
                      (c.mode === 'ask' ? ' _(plan mode)_' : ''),
                  )
                  .join('\n')
              : '';
          const helpMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            modelId: 'system',
            streaming: false,
            content:
              '**Built-in slash commands:**\n\n' +
              '_Conversation:_\n' +
              '- `/clear`, `/reset` — wipe this conversation (reset = also resets mode/agent flags)\n' +
              '- `/new` — fresh thread\n' +
              '- `/compact`, `/summarize` — résume les anciens messages pour libérer du contexte\n' +
              '- `/export` — sauve la conversation en `.md` dans `.suxai/exports/`\n\n' +
              '_Modes & model:_\n' +
              '- `/plan` — toggle Plan mode (read-only investigation, produces a markdown plan)\n' +
              '- `/agent` — toggle Agent mode (lets Claude read/edit your files)\n' +
              '- `/model` — hint pour ouvrir le model selector\n\n' +
              '_Memories (faits durables sur le projet):_\n' +
              '- `/memory <Title>: <content>` — sauve une mémoire manuelle\n' +
              '- `/memories` — liste les mémoires du workspace\n' +
              '- `/memory-delete <id>` — supprime une mémoire (ids visibles via `/memories`)\n\n' +
              '_Tâches:_\n' +
              '- `/explain`, `/refactor`, `/fix`, `/optimize` — task shortcuts on the current file/selection\n' +
              '- `/init` — génère AGENTS.md depuis le repo map\n\n' +
              '**@-mentions** (dans le chat) :\n\n' +
              '- `@<path>` — fichier (auto-completion fuzzy)\n' +
              '- `@selection`, `@cursor` — code sélectionné / autour du curseur\n' +
              '- `@open-tabs`, `@tabs` — tous les fichiers ouverts\n' +
              '- `@problems`, `@lint` — diagnostics du fichier actif\n' +
              '- `@recent_changes`, `@recent_edits` — derniers edits\n' +
              '- `@git`, `@diff` — git diff du working tree\n' +
              '- `@memories` — dump les mémoires courantes\n\n' +
              '**Editor shortcuts:**\n\n' +
              '- `Cmd/Ctrl+S` — save file\n' +
              '- `Cmd/Ctrl+K` — inline AI edit on selection\n' +
              '- `Cmd/Ctrl+L` — add selection to chat\n' +
              '- `Cmd/Ctrl+P` — quick open files\n' +
              '- `Cmd/Ctrl+Shift+P` — command palette\n' +
              '- `Ctrl+`` — toggle terminal\n\n' +
              '**Diff shortcuts (when an inline diff is open):**\n\n' +
              '- `Alt+↵` — accept current hunk\n' +
              '- `Shift+Alt+⌫` — reject current hunk\n' +
              '- `Alt+J` / `Alt+K` — next / previous hunk\n' +
              '- `Cmd/Ctrl+↵` — accept all changes\n' +
              '- `Esc` — close the diff (= reject all)' +
              customSection,
          };
          setMessages((m) => [...m, helpMsg]);
          setInput('');
          return true;
        }
        case 'plan': {
          if (!activeConvId) return true;
          setConversations((list) =>
            list.map((c) =>
              c.id === activeConvId
                ? {
                    ...c,
                    mode: c.mode === 'ask' ? 'composer' : 'ask',
                    agentMode: c.mode === 'ask' ? c.agentMode : true,
                  }
                : c,
            ),
          );
          setInput('');
          toast.info(
            activeConv?.mode === 'ask' ? 'Plan mode OFF' : 'Plan mode ON',
          );
          return true;
        }
        case 'agent': {
          if (!activeConvId) return true;
          setConversations((list) =>
            list.map((c) =>
              c.id === activeConvId
                ? {
                    ...c,
                    agentMode: !c.agentMode,
                    mode: !c.agentMode ? c.mode : 'composer',
                  }
                : c,
            ),
          );
          setInput('');
          toast.info(activeConv?.agentMode ? 'Agent mode OFF' : 'Agent mode ON');
          return true;
        }
        case 'model': {
          // Stash a hint in the textarea and let the user click the
          // model dropdown — no programmatic open since the dropdown
          // is a portal driven by its own state.
          setInput('');
          toast.info('Open the model selector', `Currently: ${modelId}`);
          return true;
        }
        case 'compact': {
          // Real compaction via Haiku 4.5: summarize everything but
          // the last 6 turns into a single block, replace the old
          // history with that summary in-place. Context window
          // shrinks dramatically for the rest of the conversation;
          // model retains the key facts, file paths, decisions.
          if (!activeConv || messages.length <= 8) {
            toast.info(
              'Nothing to compact',
              'Conversation already small. Compaction kicks in around 8+ turns.',
            );
            setInput('');
            return true;
          }
          setInput('');
          void compactConversation();
          return true;
        }
        case 'init': {
          // Generate AGENTS.md from the workspace's repo map +
          // top-of-tree files. The user reviews the proposal in an
          // inline diff before it lands on disk.
          if (!workspaceRoot) {
            setInput('');
            toast.error('/init needs a workspace', 'Open a folder first.');
            return true;
          }
          setInput('');
          void runInitWorkflow();
          return true;
        }
        case 'summarize':
        case 'compact-now': {
          // v0.13.0 — alias for /compact, matches Cursor's terminology.
          if (!activeConv || messages.length <= 8) {
            toast.info('Nothing to summarize', 'Conversation is too short.');
            setInput('');
            return true;
          }
          setInput('');
          void compactConversation();
          return true;
        }
        case 'reset': {
          // v0.13.0 — like /clear but also resets the conversation
          // mode + model to defaults. Useful when the user wants a
          // truly fresh slate without creating a new thread.
          if (!activeConvId) return true;
          setConversations((list) =>
            list.map((c) =>
              c.id === activeConvId
                ? {
                    ...c,
                    messages: [],
                    title: 'New conversation',
                    mode: 'composer',
                    agentMode: true,
                  }
                : c,
            ),
          );
          setInput('');
          toast.info('Conversation reset', 'Cleared + back to Agent / Composer defaults');
          return true;
        }
        case 'new': {
          // v0.13.0 — same as the + button, creates a fresh thread.
          setInput('');
          newConversation();
          return true;
        }
        case 'memory':
        case 'remember': {
          // v0.13.2 — save a manual memory.
          // Syntax: /memory Title: content sentence.
          //         /remember Use Tailwind v4 in this project
          // The first colon (if any) splits title from content.
          // Without a colon, the whole arg becomes both title (60c
          // truncated) and content.
          const trimmed = arg.trim();
          if (!trimmed) {
            toast.error('Usage', '/memory <Title>: <content sentence>');
            return true;
          }
          const colonIdx = trimmed.indexOf(':');
          // v0.15.10 (audit-3 #3) — when no colon is present, the old
          // code used the full untrimmed input as content, bypassing
          // the 300-char cap. Apply the same caps in both branches so
          // a single rogue paste can't dump 5 KB into the memory store.
          const title = colonIdx > 0
            ? trimmed.slice(0, colonIdx).trim().slice(0, 60)
            : trimmed.slice(0, 60);
          const content = colonIdx > 0
            ? trimmed.slice(colonIdx + 1).trim().slice(0, 300)
            : trimmed.slice(0, 300);
          if (!title || !content) {
            toast.error('Memory rejected', 'Title and content cannot be empty.');
            return true;
          }
          addMemory(workspaceRoot, { title, content });
          setInput('');
          toast.info('Memory saved', `"${title}" — apparaît dans le préambule des prochains tours`);
          return true;
        }
        case 'memories': {
          // v0.13.2 — list all stored memories for the current workspace.
          const list = loadMemories(workspaceRoot);
          const body =
            list.length === 0
              ? '_No memories stored for this workspace yet._\n\nUse `/memory Title: content` to save one. They appear in the AI preamble alongside `AGENTS.md` so the model has them on every turn.'
              : `**${list.length} memor${list.length > 1 ? 'ies' : 'y'} for this workspace:**\n\n` +
                list
                  .map((m) => `- **${m.title}** — ${m.content}\n  _id: \`${m.id}\` — \`/memory-delete ${m.id}\` to remove_`)
                  .join('\n');
          const helpMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            modelId: 'system',
            streaming: false,
            content: body,
          };
          setMessages((m) => [...m, helpMsg]);
          setInput('');
          return true;
        }
        case 'multitask':
        case 'worktree':
        case 'best-of-n': {
          // v0.13.6 — placeholders. Phase 3 features (sub-agents
          // async, git worktrees, parallel best-of-N) need cloud
          // infra not yet wired. Toast tells the user where we are.
          setInput('');
          toast.info(
            `/${cmd} arrives in v0.14+`,
            'Cette commande nécessite des sub-agents cloud — pas encore implémenté. Suis la roadmap dans le repo.',
          );
          return true;
        }
        case 'export': {
          // v0.13.7 — export current conversation to markdown.
          // Saves to <workspace>/.suxai/exports/<title>-<date>.md
          // (or just downloads if no workspace open).
          const conv = activeConv;
          if (!conv || conv.messages.length === 0) {
            toast.error('Nothing to export', 'Conversation is empty.');
            setInput('');
            return true;
          }
          const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          const slug = (conv.title || 'conversation')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40) || 'conversation';
          const md =
            `# ${conv.title}\n\n` +
            `_Exported ${new Date().toLocaleString()} — model ${conv.messages[0]?.modelId ?? 'unknown'}_\n\n` +
            conv.messages
              .map((m) => {
                const role = m.role === 'user' ? '👤 **User**' : '🤖 **Assistant**';
                const meta = m.modelId ? ` (${m.modelId})` : '';
                const tools =
                  m.toolCalls && m.toolCalls.length > 0
                    ? '\n\n_Tools used: ' +
                      m.toolCalls.map((tc) => `\`${tc.name}\``).join(', ') +
                      '_'
                    : '';
                return `## ${role}${meta}\n\n${m.content || '_(empty)_'}${tools}`;
              })
              .join('\n\n---\n\n');
          setInput('');
          if (workspaceRoot && window.suxai.fs.writeFile) {
            const path = `${workspaceRoot}/.suxai/exports/${slug}-${date}.md`;
            (async () => {
              try {
                await window.suxai.fs.writeFile(path, md, { skipMtimeCheck: true });
                toast.info('Conversation exported', `Saved to ${path}`);
              } catch (err) {
                toast.error('Export failed', (err as Error).message);
              }
            })();
          } else {
            // No workspace — download via Blob.
            try {
              const blob = new Blob([md], { type: 'text/markdown' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${slug}-${date}.md`;
              a.click();
              URL.revokeObjectURL(url);
              toast.info('Conversation exported', 'Downloaded as .md file.');
            } catch (err) {
              toast.error('Export failed', (err as Error).message);
            }
          }
          return true;
        }
        case 'memory-delete': {
          // v0.13.2 — delete a memory by id (returned by /memories).
          const id = arg.trim();
          if (!id) {
            toast.error('Usage', '/memory-delete <id>  (run /memories to see ids)');
            return true;
          }
          const before = loadMemories(workspaceRoot).length;
          deleteMemory(workspaceRoot, id);
          const after = loadMemories(workspaceRoot).length;
          setInput('');
          if (after < before) toast.info('Memory deleted');
          else toast.error('Memory not found', `No memory with id "${id}"`);
          return true;
        }
      }
      // Custom commands from <workspace>/.suxai/commands/<name>.md.
      // Variables substituted: {{selection}}, {{file}}, {{arg}}.
      // The body becomes the user's next prompt verbatim — no LLM
      // round-trip yet, the user still presses send.
      const custom = customCommands.find((c) => c.name === cmd);
      if (custom) {
        let body = custom.body;
        body = body.replace(/\{\{\s*selection\s*\}\}/g, selection || '');
        body = body.replace(/\{\{\s*file\s*\}\}/g, activeFile?.path ?? '');
        body = body.replace(/\{\{\s*arg\s*\}\}/g, arg);
        setInput(body);
        // Optional: switch mode if the command asked for it.
        if (custom.mode && activeConvId) {
          setConversations((list) =>
            list.map((c) =>
              c.id === activeConvId ? { ...c, mode: custom.mode!, agentMode: true } : c,
            ),
          );
        }
        toast.info(
          `/${cmd}${custom.description ? ' — ' + custom.description : ''}`,
          'Body loaded into composer. Press send to run.',
        );
        return true;
      }
      // Argument-bearing fall-through (`/something foo bar`) → not a
      // built-in. Swallow only if cmd looks like a no-arg builtin we
      // know about. Otherwise return false so the AI command parser
      // gets a chance.
      void arg;
      return false;
    },
    [
      activeConvId, activeConv, activeConv?.mode, activeConv?.agentMode,
      modelId, setMessages, toast, customCommands,
      selection, activeFile?.path, messages, compactConversation, runInitWorkflow,
      workspaceRoot,
    ],
  );

  // Extract @path/to/file mentions from the composer and read their content
  // so the AI gets them as explicit context. Returns the cleaned prompt
  // (without the @-mentions) and the loaded attachments.
  /**
   * Extract @-mentions from the user's raw input and resolve each one
   * to an inline content block. Supports a Cursor-like vocabulary on
   * top of the legacy @file:
   *
   *   @selection         — current editor selection
   *   @cursor            — line around the cursor (-5/+5)
   *   @problems          — Monaco markers (errors/warnings) for active file
   *   @recent_changes    — recent edits ring buffer
   *   @recent            — recently viewed files
   *   @workspace         — workspace root
   *   @<bare-name>       — fuzzy match against an open file's path/name
   *   @<absolute-path>   — read the file via fs.readFile
   *
   * Returns a cleaned prompt (mentions stripped) and an array of
   * resolved attachments. Each attachment becomes a <<<FILE … END>>>
   * block in the outgoing prompt.
   */
  const extractMentions = useCallback(
    async (raw: string): Promise<{ cleaned: string; attachments: { path: string; content: string }[] }> => {
      // v0.13.8 fix : unicode-safe regex pour matcher @café, @résumé,
      // @中文/foo.ts, etc. Avant : `[a-zA-Z_]` cassait sur le 1er
      // caractère accentué — `@café/foo.ts` était matché comme `@caf`
      // et le reste du chemin restait dans le prompt non résolu.
      // \p{L} couvre toutes les lettres unicode, \p{N} les chiffres,
      // _ et - explicites pour les noms de symboles.
      const re = /@([\p{L}_][\p{L}\p{N}_-]*|[^\s@\n]+)/gu;
      const matches = [...raw.matchAll(re)];
      if (matches.length === 0) return { cleaned: raw, attachments: [] };
      const attachments: { path: string; content: string }[] = [];
      const consumed: string[] = [];
      for (const m of matches) {
        const ref = m[1];
        let resolved: { path: string; content: string } | null = null;
        switch (ref.toLowerCase()) {
          case 'selection': {
            if (selection) {
              resolved = {
                path: '@selection',
                content: `Current editor selection${activeFile ? ' (' + activeFile.path + ')' : ''}:\n${selection}`,
              };
            }
            break;
          }
          case 'cursor': {
            if (activeFile && editorContext.cursorPosition) {
              const cur = editorContext.cursorPosition.line;
              const lines = activeFile.content.split('\n');
              const start = Math.max(0, cur - 6);
              const end = Math.min(lines.length, cur + 5);
              const window = lines.slice(start, end).join('\n');
              resolved = {
                path: '@cursor',
                content:
                  `Active file: ${activeFile.path}\nLines ${start + 1}-${end} (cursor at line ${cur}):\n${window}`,
              };
            }
            break;
          }
          case 'problems':
          case 'lint':
          case 'lint_errors': {
            if (editorContext.diagnostics.length > 0) {
              resolved = {
                path: '@problems',
                content:
                  'Linter / language-server diagnostics on the active file:\n' +
                  editorContext.diagnostics
                    .map((d) => `[${d.severity}] ${d.path}:${d.line}:${d.column} — ${d.message}`)
                    .join('\n'),
              };
            }
            break;
          }
          case 'recent_changes':
          case 'recent_edits': {
            if (editorContext.recentEdits.length > 0) {
              resolved = {
                path: '@recent_changes',
                content:
                  'Recent edits (newest first):\n' +
                  editorContext.recentEdits
                    .map((e) => {
                      const ago = Math.max(1, Math.round((Date.now() - e.ts) / 1000));
                      return `- ${e.path} line ${e.line} (${ago}s ago)`;
                    })
                    .join('\n'),
              };
            }
            break;
          }
          case 'recent':
          case 'recently_viewed': {
            if (editorContext.recentlyViewedFiles.length > 0) {
              resolved = {
                path: '@recent',
                content:
                  'Recently viewed files (most recent first):\n' +
                  editorContext.recentlyViewedFiles.map((p) => `- ${p}`).join('\n'),
              };
            }
            break;
          }
          case 'workspace': {
            if (workspaceRoot) {
              resolved = {
                path: '@workspace',
                content: `Workspace root: ${workspaceRoot}`,
              };
            }
            break;
          }
          case 'tabs':
          case 'open-tabs':
          case 'open_tabs': {
            // v0.13.6 — full content of every currently open tab.
            // Useful for asks like "@open-tabs réorganise ces fichiers
            // en suivant la convention X" without manually @-ing each.
            // v0.13.8 — cap per-file size to 200 KB and total to 1 MB
            // so a 100 MB log file doesn't blow the request payload.
            if (openFiles.length > 0) {
              const PER_FILE_CAP = 200_000;
              const TOTAL_CAP = 1_000_000;
              let total = 0;
              const blocks: string[] = [];
              for (const f of openFiles) {
                if (total >= TOTAL_CAP) {
                  blocks.push(
                    `<!-- Skipped ${openFiles.length - blocks.length} more files: total cap reached. Use specific @path to include them. -->`,
                  );
                  break;
                }
                const safePath = f.path.replace(/"/g, '&quot;');
                let body = f.content;
                let suffix = '';
                if (body.length > PER_FILE_CAP) {
                  suffix = `\n[truncated — file is ${body.length} bytes, kept first ${PER_FILE_CAP}]`;
                  body = body.slice(0, PER_FILE_CAP);
                }
                const block = `<file path="${safePath}">\n${body}${suffix}\n</file>`;
                if (total + block.length > TOTAL_CAP) {
                  blocks.push(
                    `<!-- ${f.path} omitted: would exceed total cap of ${TOTAL_CAP} bytes. -->`,
                  );
                  break;
                }
                blocks.push(block);
                total += block.length;
              }
              resolved = {
                path: '@open-tabs',
                content: `${openFiles.length} open tab${openFiles.length > 1 ? 's' : ''}:\n\n${blocks.join('\n\n')}`,
              };
            }
            break;
          }
          case 'memories': {
            // v0.13.6 — dump current memories as context. Lets the
            // user remind the model "what do you remember about
            // this project ?" without leaving the conv.
            const list = loadMemories(workspaceRoot);
            if (list.length > 0) {
              resolved = {
                path: '@memories',
                content:
                  `${list.length} stored memor${list.length > 1 ? 'ies' : 'y'} for this workspace:\n\n` +
                  list.map((m) => `- **${m.title}**: ${m.content}`).join('\n'),
              };
            }
            break;
          }
          case 'git':
          case 'diff': {
            // v0.13.6 — git diff of unstaged + staged changes via
            // run-once. Cap output to keep the context tight.
            if (workspaceRoot && window.suxai.terminal?.runOnce) {
              try {
                const r = await window.suxai.terminal.runOnce({
                  command: 'git -c core.pager=cat diff HEAD',
                  cwd: workspaceRoot,
                  timeout_ms: 10_000,
                });
                if (r.stdout && r.stdout.trim()) {
                  // Cap at 24 KB so a multi-thousand-line diff doesn't
                  // blow the request size.
                  const capped =
                    r.stdout.length > 24_000
                      ? r.stdout.slice(0, 24_000) +
                        '\n\n[…diff truncated, ' + (r.stdout.length - 24_000) + ' more bytes]'
                      : r.stdout;
                  resolved = {
                    path: '@git',
                    content:
                      'Working-tree diff (`git diff HEAD`, includes both staged and unstaged):\n\n```diff\n' +
                      capped +
                      '\n```',
                  };
                } else if (r.exit_code === 0) {
                  resolved = {
                    path: '@git',
                    content: 'Working tree is clean — no diff against HEAD.',
                  };
                }
              } catch {
                /* not a git repo / git missing — leave unresolved */
              }
            }
            break;
          }
          default: {
            // File mention — try open files first, then read from disk.
            // v0.13.8 — cap per-file size to 500 KB so a multi-MB log
            // file or generated bundle attached as @<path> doesn't
            // explode the request payload. Truncated with a clear
            // marker so the model knows to ask for a specific range.
            const FILE_MENTION_CAP = 500_000;
            const truncate = (content: string): string => {
              if (content.length <= FILE_MENTION_CAP) return content;
              const dropped = content.length - FILE_MENTION_CAP;
              return (
                content.slice(0, FILE_MENTION_CAP) +
                `\n\n[truncated — ${dropped} more bytes (~${Math.round(dropped / 1000)} KB) not shown — re-mention with a tighter range or use read_file for line-bounded access]`
              );
            };
            const open = openFiles.find(
              (f) => f.path.endsWith(ref) || f.name === ref,
            );
            if (open) {
              resolved = { path: open.path, content: truncate(open.content) };
            } else {
              try {
                const r = await window.suxai.fs.readFile(ref);
                resolved = { path: r.path, content: truncate(r.content) };
              } catch {
                /* unresolved — leave the @mention in the prompt as-is */
              }
            }
          }
        }
        if (resolved) {
          attachments.push(resolved);
          consumed.push(m[0]);
        }
      }
      // Strip ONLY the mentions we successfully resolved; unresolved
      // ones stay in the prompt as the user typed them, in case the
      // model can still make sense of them.
      // v0.13.8 fix : .replace(c, '') ne supprimait que la 1ère
      // occurrence — un user qui répétait `@git check then @git log`
      // gardait un `@git` orphelin dans le prompt après resolution.
      // split/join supprime toutes les occurrences sans regex escape.
      let cleaned = raw;
      const seenStrings = new Set<string>();
      for (const c of consumed) {
        if (seenStrings.has(c)) continue;
        seenStrings.add(c);
        cleaned = cleaned.split(c).join('');
      }
      cleaned = cleaned.replace(/\s+/g, ' ').trim();
      return { cleaned, attachments };
    },
    [openFiles, selection, activeFile, editorContext, workspaceRoot],
  );

  // v0.13.4 — background Haiku extraction of durable memories at the
  // tail of a finished run. Fire-and-forget — never blocks the UI,
  // never surfaces errors. Builds a compact transcript of the LAST
  // 12 messages (skipping tool noise), asks Haiku to nominate up to
  // 5 candidates, then shows ONE toast per accepted candidate so the
  // user can save with a click. Fails silently on any error.
  const runMemoryExtraction = useCallback(
    async (convId: string, jwt: string): Promise<void> => {
      const conv = conversations.find((c) => c.id === convId);
      if (!conv || conv.messages.length < 6) return;
      const tailCount = Math.min(12, conv.messages.length);
      const transcript = conv.messages
        .slice(-tailCount)
        .filter((m) => m.content.trim().length > 0)
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1200)}`)
        .join('\n\n---\n\n');
      if (transcript.length < 200) return;
      const fetchHaiku = (prompt: string): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          let acc = '';
          streamAi(
            jwt,
            {
              modelId: 'claude-haiku-4-5-20251001',
              command: 'chat',
              prompt,
            },
            {
              onToken: (t) => { acc += t; },
              onDone: (full) => resolve(full || acc),
              onError: (err) => reject(err),
            },
          );
        });
      const candidates = await extractMemoriesFromTranscript(transcript, fetchHaiku);
      // Deduplicate against existing memories by case-insensitive title.
      const existing = new Set(
        loadMemories(workspaceRoot).map((m) => m.title.toLowerCase()),
      );
      for (const cand of candidates) {
        if (existing.has(cand.title.toLowerCase())) continue;
        // v0.13.4: minimal UX — info toast with the title. Manual
        // save via /memory command for now. A proper "Save" button
        // requires a custom toast component which we'll wire in
        // v0.13.5 along with /memory-edit.
        toast.info(
          `Memory candidate: ${cand.title}`,
          `${cand.content}\n\nUse \`/memory ${cand.title}: ${cand.content}\` to save.`,
        );
      }
    },
    [conversations, workspaceRoot, toast],
  );

  const sendCommand = useCallback(
    async (command: AiCommand, userText?: string) => {
      if (!token) return;
      const text = (userText ?? input).trim();
      if (!text && command === 'chat') return;

      abortRef.current?.();

      // Resolve @file mentions so the AI sees them as context without
      // the raw @-token polluting the user prompt.
      const { cleaned, attachments: resolvedMentions } = await extractMentions(text);

      // Merge explicit attachments (paperclip button) with @-mention
      // attachments — de-dup by path. Computed BEFORE the message is
      // pushed so we can stash the full prompt on the message itself.
      // Read via ref so Regenerate (which fires inside a setTimeout
      // after setAttachments) actually sees the restored list.
      const currentAttachments = attachmentsRef.current;
      const seen = new Set(currentAttachments.map((a) => a.path));
      const merged = [
        ...currentAttachments.map((a) => ({ path: a.path, content: a.content, name: a.name })),
        ...resolvedMentions.filter((a) => !seen.has(a.path)).map((a) => ({
          path: a.path,
          content: a.content,
          name: a.path.split(/[\\/]/).pop() ?? a.path,
        })),
      ];

      const attachmentBlock =
        merged.length > 0
          ? merged
              .map((a) => `\n\n<<< FILE: ${a.path} >>>\n${a.content}\n<<< END >>>`)
              .join('')
          : '';

      const visibleContent =
        command === 'chat'
          ? cleaned || text
          : `${command.toUpperCase()}${cleaned ? `: ${cleaned}` : ''}`;

      // Auto-context: when a file is open and there's no explicit
      // attachment / selection, the model still needs to know which
      // file the user means. For agent mode we inject a short header
      // pointing at the active path + selection so the model doesn't
      // have to ask "which file?" before doing anything. For plain
      // chat we ALSO send `context.filePath/fileContent` separately,
      // but the agent-mode branch never reaches that path so we have
      // to embed it inline. Skip when there's no active file or when
      // the user already attached one — don't double-spam.
      // Build the rich <additional_data> XML block. Replaces the
      // older ad-hoc "[active editor file: …]" header with a
      // structured payload the model can parse to resolve "ce script",
      // "cette fonction", "la sélection" without asking. Cursor-style.
      // Only emitted when running in agent mode AND we actually have
      // editor context — chat-only flows already get filePath via the
      // legacy `context` field on the request.
      const additionalDataXml =
        activeConv?.agentMode
          ? buildAdditionalDataXml({
              editorContext,
              // Override the tracker's URI-derived path with the
              // canonical workspace path. Monaco standalone (via
              // @monaco-editor/react) uses `inmemory:` URIs for its
              // models, so model.uri.fsPath is empty and the
              // tracker would otherwise hand the model a fake
              // `<current_file path="/0">`. The WorkspaceContext is
              // the only source of truth for "the absolute path of
              // the file the user is looking at".
              activeFilePathOverride: activeFile?.path ?? null,
              activeFileLanguage: activeFile?.language,
              workspaceRoot,
              userAlreadyAttached: merged.some((a) => a.path === activeFile?.path),
            })
          : '';

      const fullPromptForHistory =
        buildCommandPrompt(command, cleaned || selection || activeFile?.content || '') +
        additionalDataXml +
        attachmentBlock;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        command,
        content: visibleContent,
        // Stash the full prompt (with attachments + the active file
        // snippet) so subsequent turns can replay this context to the
        // model. Without this the AI loses the file the conversation
        // started about as soon as we move past turn 1.
        historyContent: fullPromptForHistory,
        attachments: merged.length > 0 ? merged : undefined,
      };
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        streaming: true,
        modelId,
      };
      setMessages((m) => [...m, userMsg, assistantMsg]);
      setInput('');
      setAttachments([]);
      setStreaming(true);

      const prompt = fullPromptForHistory;

      // Snapshot the target file at send-time — if the user switches tabs
      // mid-stream, we still diff against the file they asked about.
      // We open a diff for: explicit edit commands (fix/refactor/optimize)
      // OR plain chat where the user's wording suggests they want the
      // model to rewrite the active file ("modifie", "change", "réécris",
      // "rewrite", etc.). Without this heuristic the user just sees a
      // wall of code in the chat instead of an inline diff on their file.
      const editIntentRe =
        /\b(modif(y|ie|y|ier)|change(s)?|update|rewrite|r[eé][ée]cri[st]?|fix|patch|apply|implement|implémente)\b/i;
      const looksLikeEditRequest =
        command === 'chat' && !!activeFile && editIntentRe.test(text);
      const diffTarget =
        command === 'fix' ||
        command === 'refactor' ||
        command === 'optimize' ||
        looksLikeEditRequest
          ? activeFile
          : null;

      // Prior turns sent to the model. Each user turn replays its full
      // historyContent (so file dumps stay in scope), each assistant
      // turn replays its visible content. Cap at 20 turns to keep
      // requests manageable.
      const history = messages
        .filter((m) => !m.streaming && !m.error && m.content.trim().length > 0)
        .slice(-20)
        .map((m) => ({
          role: m.role,
          content:
            m.role === 'user'
              ? m.historyContent ?? m.content
              : m.content,
        }));

      // ── Agent mode branch ──────────────────────────────────────────
      // Anthropic-only for now. The model gets the AGENT_TOOLS schema
      // and decides when to call read_file / list_dir / edit_file etc.
      // Each tool call runs locally (with user approval for writes),
      // its result is fed back as a user/tool_result message, and we
      // loop until the model emits stop_reason='end_turn'.
      if (
        activeConv?.agentMode &&
        modelProviderForId(modelId) === 'anthropic' &&
        token
      ) {
        // Install a no-op abort handler immediately so the user's
        // Stop button isn't a dead button between setStreaming(true)
        // and the first streamAi() call inside runAgentLoop. The
        // real cancel handler replaces this within milliseconds.
        let preambleCancelled = false;
        abortRef.current = () => {
          preambleCancelled = true;
        };
        // Pre-turn checkpoint: snapshot every open file + the active
        // file so the user can roll back if the agent's edits go
        // wrong. Best-effort — snapshot failures don't block the
        // turn (we just lose the safety net for this particular
        // round). Plan-mode turns skip this because they can't write.
        if (
          workspaceRoot &&
          window.suxai.checkpoint?.create &&
          activeConv?.mode !== 'ask'
        ) {
          const candidates = Array.from(
            new Set([
              activeFile?.path,
              ...openFiles.map((f) => f.path),
            ].filter((p): p is string => !!p && !p.startsWith('untitled://'))),
          );
          if (candidates.length > 0) {
            try {
              await window.suxai.checkpoint.create(
                workspaceRoot,
                userMsg.id,
                candidates,
              );
              // Stamp the user message so the "Restore" button shows
              // up next to it.
              setMessages((m) =>
                m.map((msg) =>
                  msg.id === userMsg.id ? { ...msg, checkpointId: userMsg.id } : msg,
                ),
              );
            } catch (err) {
              console.warn('[checkpoint] pre-turn snapshot failed:', err);
            }
          }
        }
        // Load AGENTS.md/CLAUDE.md once per workspace and reuse the
        // string across iterations — avoids repeated FS reads and
        // keeps the prompt prefix stable for Anthropic caching.
        // Append a repo-map block (Aider PageRank ranking) so the
        // model has a structural overview of the codebase from
        // turn 1 — saves expensive list_dir / read_file roundtrips.
        let preamble = '';
        if (preambleRef.current?.root === workspaceRoot) {
          preamble = preambleRef.current.preamble;
        } else {
          const guidance = await loadProjectPreamble(workspaceRoot);
          let repoMap = '';
          try {
            const text = await buildRepoMap({
              workspaceRoot,
              activeFilePath: activeFile?.path ?? null,
              openPaths: openFiles.map((f) => f.path),
              recentPaths: editorContext.recentlyViewedFiles,
              budgetTokens: 1024,
            });
            repoMap = formatRepoMapBlock(text);
          } catch (err) {
            console.warn('[repo-map] build failed:', err);
          }
          preamble = [guidance, repoMap].filter(Boolean).join('\n\n---\n\n');
          preambleRef.current = { root: workspaceRoot, preamble };
        }
        // v0.13.0 — append memories block. Read fresh on every turn
        // (not cached in preambleRef) so a memory added mid-session
        // shows up on the next message immediately.
        const memoriesBlock = formatMemories(loadMemories(workspaceRoot));
        if (memoriesBlock) {
          preamble = preamble
            ? preamble + '\n\n---\n\n' + memoriesBlock
            : memoriesBlock;
        }
        if (preambleCancelled) {
          // User hit Stop while preamble was loading. Bail before we
          // even open a stream.
          setMessages((m) =>
            m.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)),
          );
          setStreaming(false);
          abortRef.current = null;
          return;
        }
        // POST /ai/apply bridge for the apply_lazy_edit tool. Local
        // closure so we can reuse the current JWT — falls back to
        // null on any failure (network, 401, 5xx, malformed).
        const applyLazyEditBridge = async (input: {
          path: string;
          original: string;
          lazy_edit: string;
          instruction?: string;
        }): Promise<string | null> => {
          if (!token) return null;
          try {
            const { API_BASE_URL } = await import('../../config');
            const { tryRefreshToken } = await import('../../api/client');
            const doFetch = async (jwt: string) =>
              fetch(`${API_BASE_URL}/ai/apply`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  authorization: `Bearer ${jwt}`,
                },
                body: JSON.stringify(input),
              });
            let res = await doFetch(token);
            if (res.status === 401) {
              try { await res.text(); } catch { /* drain */ }
              const fresh = await tryRefreshToken();
              if (fresh) res = await doFetch(fresh);
            }
            if (!res.ok) return null;
            const obj = (await res.json()) as { result?: string };
            return obj.result ?? null;
          } catch {
            return null;
          }
        };

        runAgentLoop({
          token,
          modelId,
          mode: activeConv?.mode ?? 'composer',
          workspaceRoot,
          firstUserMsg: userMsg,
          firstAssistantMsg: assistantMsg,
          conversationMessages: [...messages, userMsg, assistantMsg],
          preamble,
          setMessages,
          setStreaming,
          abortRef,
          toast,
          requestApproval,
          applyLazyEdit: applyLazyEditBridge,
          getApprovalMode: () => approvalModeRef.current,
        })
          .then(() => {
            // v0.13.4 — auto-extract memories at end of a meaningful
            // run. Once-per-conversation guard means at most one
            // background Haiku call per thread per session.
            const convId = activeConvId;
            if (
              token &&
              workspaceRoot &&
              convId &&
              !memoryExtractedRef.current.has(convId)
            ) {
              memoryExtractedRef.current.add(convId);
              // v0.15.10 (audit-3 #2) — attach .catch so an exception
              // inside the background extraction (Haiku 5xx, network,
              // store schema mismatch) doesn't surface as an
              // unhandledrejection in the renderer.
              runMemoryExtraction(convId, token).catch((err) => {
                console.error('[memory-extract] failed:', err);
              });
            }
          })
          .catch((err) => {
          console.error('[agent] loop failed:', err);
          // v2.0.2 — surface the failure to the user via toast (visible
          // immediately even if the assistant message is scrolled off
          // or the user is staring at another tab). Keeps the existing
          // inline error pill on the message.
          const errMsg = (err as Error).message || String(err);
          toast.error(
            'Agent loop failed',
            errMsg.length > 200 ? errMsg.slice(0, 200) + '…' : errMsg,
          );
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantMsg.id
                ? { ...msg, streaming: false, error: errMsg }
                : msg,
            ),
          );
          setStreaming(false);
          abortRef.current = null;
        });
        return;
      }

      const cancel = streamAi(
        token,
        {
          modelId,
          command,
          prompt,
          history,
          context: {
            filePath: activeFile?.path,
            language: activeFile?.language,
            fileContent: activeFile?.content,
            selection,
          },
        },
        {
          onToken: (chunk) => {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantMsg.id ? { ...msg, content: msg.content + chunk } : msg,
              ),
            );
          },
          onDone: (full) => {
            // Auto-open the inline diff if the model returned a sizable
            // code block AND we have a current file to compare against.
            // We mark the message `divertedToFile` so the chat hides
            // the wall-of-code chip in favour of an "Open in editor"
            // pill — the user sees the change AS A DIFF on their file,
            // not as a duplicate code dump in the conversation.
            let divertedTo: string | null = null;
            if (diffTarget) {
              const proposed = extractFirstCodeBlock(full);
              if (proposed && proposed.trim() !== diffTarget.content.trim()) {
                openDiff({
                  path: diffTarget.path,
                  original: diffTarget.content,
                  proposed,
                  label: `${command} · ${modelId}`,
                });
                divertedTo = diffTarget.path;
              }
            }
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantMsg.id
                  ? {
                      ...msg,
                      streaming: false,
                      ...(divertedTo ? { divertedToFile: divertedTo } : {}),
                    }
                  : msg,
              ),
            );
            setStreaming(false);
            abortRef.current = null;
          },
          onError: (err) => {
            // v0.11.8: human-readable message when the upstream
            // stream was truncated mid-flight (network drop, idle
            // proxy timeout, Anthropic 529). The user can just
            // resend their message to retry; the heartbeat in
            // v0.11.7 made this much rarer but it's still possible
            // on flaky mobile networks.
            const code = (err as Error & { code?: string }).code;
            const friendly =
              code === 'STREAM_TRUNCATED'
                ? `Connexion interrompue avant la fin de la réponse — relance ta question pour reprendre. (${err.message})`
                : err.message;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantMsg.id
                  ? { ...msg, streaming: false, error: friendly }
                  : msg,
              ),
            );
            setStreaming(false);
            abortRef.current = null;
          },
        },
      );
      abortRef.current = cancel;
    },
    // attachments dropped from deps — we read it via attachmentsRef above.
    [token, input, selection, activeFile, modelId, extractMentions, messages, activeConv?.agentMode, setMessages, toast, requestApproval, workspaceRoot],
  );

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    setStreaming(false);
    setMessages((m) =>
      m.map((msg) => {
        if (!msg.streaming) return msg;
        const next: ChatMessage = { ...msg, streaming: false };
        // Drop any tool_use that was still streaming when the user
        // hit Stop. Keeping a partial tool_use in the transcript
        // would orphan it — the next request would fail with 400
        // "tool_use without tool_result".
        if (next.toolCalls && next.toolCalls.some((tc) => tc.status === 'pending')) {
          next.toolCalls = next.toolCalls.filter((tc) => tc.status !== 'pending');
          if (next.toolCalls.length === 0) delete next.toolCalls;
        }
        return next;
      }),
    );
  };

  // Listen for code-action commands dispatched from the editor toolbar.
  useEffect(() => onAiCommand(({ command }) => sendCommand(command)), [sendCommand]);

  // Ctrl+L from the editor: add the selected code as an attachment chip
  // so the user can add a question around it before sending.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; text: string }>).detail;
      if (!detail?.text) return;
      const virtualPath =
        detail.path ? `${detail.path}#selection-${Date.now()}` : `selection-${Date.now()}`;
      const name = detail.path
        ? `${detail.path.split(/[\\/]/).pop()} (selection)`
        : `Selection`;
      setAttachments((list) => [
        ...list.filter((a) => a.path !== virtualPath),
        { path: virtualPath, content: detail.text, name },
      ]);
    };
    window.addEventListener('suxai:add-to-chat', handler);
    return () => window.removeEventListener('suxai:add-to-chat', handler);
  }, []);

  const newConversation = useCallback(() => {
    abortRef.current?.();
    setStreaming(false);
    const fresh = emptyConversation();
    setConversations((list) => [...list, fresh]);
    setActiveConvId(fresh.id);
    setInput('');
    setAttachments([]);
  }, []);

  const switchConversation = useCallback(
    (id: string) => {
      if (id === activeConvId) return;
      abortRef.current?.();
      setStreaming(false);
      setActiveConvId(id);
      setInput('');
      setAttachments([]);
    },
    [activeConvId],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      // Two-step: first click sets pending, second click confirms.
      // Cancelled by clicking elsewhere or 4 seconds of inactivity.
      // Avoids window.confirm which blocks the renderer event loop and
      // looks out of place inside Electron.
      setPendingDelete(id);
    },
    [],
  );

  // Confirm deletion the second time deleteConversation is called for the
  // same id, then clear the pending state.
  const confirmDelete = useCallback(
    (id: string) => {
      setPendingDelete(null);
      setConversations((list) => {
        const next = list.filter((c) => c.id !== id);
        if (id === activeConvId) {
          abortRef.current?.();
          setStreaming(false);
          if (next.length > 0) {
            setActiveConvId(next[next.length - 1].id);
          } else {
            const fresh = emptyConversation();
            setActiveConvId(fresh.id);
            return [fresh];
          }
        }
        return next;
      });
      toast.info('Conversation deleted');
    },
    [activeConvId, toast],
  );

  // Auto-clear the pending delete after a short window so a stale "are
  // you sure?" never lingers across page navigation.
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 4000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  const renameConversation = useCallback((id: string, title: string) => {
    setConversations((list) =>
      list.map((c) =>
        c.id === id ? { ...c, title: title.trim() || 'Untitled', updatedAt: new Date().toISOString() } : c,
      ),
    );
  }, []);

  const onApplyCode = useCallback(
    async (code: string) => {
      if (!activeFile) return;
      if (!token) {
        toast.error('Not signed in', 'Open the menu and log in again');
        return;
      }
      // v0.13.10 fix DATA-LOSS : avant, on routait `code` directement comme
      // `proposed` du diff. Si l'IA n'avait renvoyé que le snippet modifié
      // (5 lignes au lieu du fichier complet de 500), un Accept-all
      // remplaçait toutes les 500 lignes par les 5. Pure data loss.
      //
      // Maintenant : le snippet est traité comme un "lazy edit", on
      // appelle /ai/apply (Haiku 4.5) qui le fusionne dans le fichier
      // complet en respectant les marqueurs `// ... existing code ...`
      // ou en infierant les zones inchangées. On ouvre alors le diff
      // avec le RÉSULTAT MERGÉ comme `proposed` — le user voit les
      // vraies modifs ligne par ligne, le reste du fichier intact.
      //
      // Si /ai/apply échoue (network, 502, marker leakage, truncation),
      // on surface une vraie erreur au lieu d'ouvrir un diff dangereux.
      toast.info('Application en cours…', 'Fusion du snippet dans le fichier via Haiku 4.5');
      try {
        const { API_BASE_URL } = await import('../../config');
        const { tryRefreshToken } = await import('../../api/client');
        const doFetch = async (jwt: string) =>
          fetch(`${API_BASE_URL}/ai/apply`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({
              original: activeFile.content,
              lazy_edit: code,
              instruction: 'Apply this code snippet from the chat to the active file. Preserve all unchanged lines verbatim.',
              path: activeFile.path,
            }),
          });
        let res = await doFetch(token);
        if (res.status === 401) {
          try { await res.text(); } catch { /* */ }
          const fresh = await tryRefreshToken();
          if (fresh) res = await doFetch(fresh);
        }
        if (!res.ok) {
          const code502 = res.status === 502;
          toast.error(
            'Apply failed',
            code502
              ? 'Le modèle apply n\'a pas pu fusionner proprement (truncation ou marker leakage détecté). Réessaie ou édite manuellement.'
              : `HTTP ${res.status} sur /ai/apply. Vérifie ton quota / ta connexion.`,
          );
          return;
        }
        const data = (await res.json()) as { result?: string | null };
        const merged = data.result;
        if (typeof merged !== 'string' || merged.length === 0) {
          toast.error(
            'Apply failed',
            'Réponse vide du modèle apply. Le snippet est peut-être trop ambigu — ajoute des markers `// ... existing code ...` autour des zones non modifiées et ré-essaie.',
          );
          return;
        }
        openDiff({
          path: activeFile.path,
          original: activeFile.content,
          proposed: merged,
          label: `apply · haiku-4-5`,
        });
      } catch (err) {
        toast.error('Apply failed', (err as Error).message);
      }
    },
    [activeFile, openDiff, token, toast],
  );

  const onDiffCode = useCallback(
    (code: string) => {
      if (!activeFile) return;
      openDiff({
        path: activeFile.path,
        original: activeFile.content,
        proposed: code,
        label: modelId,
      });
    },
    [activeFile, openDiff, modelId],
  );

  return (
    <aside className="ai">
      <div className="ai__header">
        {/* v0.17.2 — header restructured into 2 explicit rows :
            row 1 = identity (conversation + model)
            row 2 = mode toggles (Plan / Agent) + new-conversation
            Each row is a flex line that can wrap independently if the
            panel narrows. The `+` button is now an accent-styled
            primary action, not a bare ghost. */}
        <div className="ai__header-row ai__header-row--identity">
          <ConversationSwitcher
            conversations={conversations}
            activeId={activeConvId}
            onSwitch={switchConversation}
            onNew={newConversation}
            onDelete={deleteConversation}
            onConfirmDelete={confirmDelete}
            pendingDeleteId={pendingDelete}
            onRename={renameConversation}
          />
          <ModelSelector value={modelId} onChange={setModelId} />
        </div>
        <div className="ai__header-row ai__header-row--actions">
          <button
            type="button"
            className={
              `ai__plan-toggle ${activeConv?.mode === 'ask' ? 'ai__plan-toggle--on' : ''}`
            }
            onClick={() => {
              if (!activeConvId) return;
              if (modelProviderForId(modelId) !== 'anthropic') {
                toast.info(
                  'Plan mode needs Claude',
                  'Pick an Anthropic model — Plan mode uses agent tools, available on Claude only for now.',
                );
                return;
              }
              setConversations((list) =>
                list.map((c) =>
                  c.id === activeConvId
                    ? {
                        ...c,
                        mode: c.mode === 'ask' ? 'composer' : 'ask',
                        // Activating Plan mode also implies agent mode
                        // (it's an agent flow with a restricted tool set).
                        agentMode: c.mode === 'ask' ? c.agentMode : true,
                      }
                    : c,
                ),
              );
            }}
            title={
              activeConv?.mode === 'ask'
                ? 'Plan mode ON — read-only investigation, produces a markdown plan'
                : 'Plan mode OFF — switch on to investigate without editing'
            }
            aria-pressed={activeConv?.mode === 'ask'}
          >
            <AtelierIcon name="i-suggestion" size={11} />
            <span>Plan</span>
          </button>
          <button
            type="button"
            className={`ai__agent-toggle ${activeConv?.agentMode ? 'ai__agent-toggle--on' : ''}`}
            onClick={() => {
              if (!activeConvId) return;
              if (modelProviderForId(modelId) !== 'anthropic') {
                toast.info(
                  'Agent mode needs Claude',
                  'Pick an Anthropic model — agent tools are wired through Claude only for now.',
                );
                return;
              }
              setConversations((list) =>
                list.map((c) =>
                  c.id === activeConvId
                    ? {
                        ...c,
                        agentMode: !c.agentMode,
                        // Toggling agent off also implicitly leaves Plan
                        // mode (Plan is meaningless without agent tools).
                        mode: !c.agentMode ? c.mode : 'composer',
                      }
                    : c,
                ),
              );
            }}
            title={
              activeConv?.agentMode
                ? 'Agent mode ON — Claude can read/edit files (with your approval)'
                : 'Agent mode OFF — chat only'
            }
            aria-pressed={!!activeConv?.agentMode}
          >
            <span className="ai__agent-dot" aria-hidden />
            <span>Agent</span>
          </button>
          <button
            className="ai__new-conv"
            onClick={newConversation}
            title="New conversation"
            aria-label="New conversation"
          >
            <AtelierIcon name="i-plus" size={13} />
            <span>New</span>
          </button>
        </div>
      </div>

      <div className="ai__commands">
        <button className="ai__cmd" onClick={() => sendCommand('explain')} disabled={!token || streaming} title="/explain">
          <span>Explain</span>
        </button>
        <button className="ai__cmd" onClick={() => sendCommand('refactor')} disabled={!token || streaming} title="/refactor">
          <span>Refactor</span>
        </button>
        <button className="ai__cmd" onClick={() => sendCommand('fix')} disabled={!token || streaming} title="/fix">
          <span>Fix bugs</span>
        </button>
        <button className="ai__cmd" onClick={() => sendCommand('optimize')} disabled={!token || streaming} title="/optimize">
          <span>Optimize</span>
        </button>
      </div>

      <div
        className="ai__messages"
        ref={scrollRef}
        onScroll={onMessagesScroll}
      >
        {messages.length === 0 ? (
          <div className="ai__empty">
            <div className="ai__empty-icon" aria-hidden>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 2 L14 9 L21 11 L14 13 L12 21 L10 13 L3 11 L10 9 Z"
                  fill="url(#g1)"
                  stroke="currentColor"
                  strokeWidth="0.6"
                  strokeLinejoin="round"
                />
                <defs>
                  {/* REFACTOR-NOTE: SVG <stop> requires a colour string,
                      can't read CSS vars in all engines. We use the amber
                      tokens directly via CSS-readable getComputedStyle
                      would be heavy here ; we accept these two amber
                      stops as the brand-mark gradient (matches the
                      SuxaiLogo plate). */}
                  <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="var(--amber-9, #F5C97A)" />
                    <stop offset="100%" stopColor="var(--amber-7, #553A1F)" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <div className="ai__empty-badge">{selectedModel.label}</div>
            <h3>Ready when you are</h3>
            <p>
              Ask a question, attach a file, or pick one of the prompts below.
              The AI sees your active file and any code you select — never your
              whole project.
            </p>
            <div className="ai__empty-chips">
              {[
                'Explain the active file',
                'Find a bug in the selection',
                'Refactor for readability',
                'Write a unit test for this',
                'Convert this to TypeScript',
              ].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="ai__empty-chip"
                  onClick={() => {
                    setInput(p);
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <Message
              key={m.id}
              message={m}
              onApply={onApplyCode}
              onDiff={onDiffCode}
              onDelete={(target) =>
                setMessages((list) => list.filter((x) => x.id !== target.id))
              }
              onRegenerate={(target) => {
                if (target.role !== 'assistant') return;
                // Find the user message that prompted this reply, drop
                // both, and re-send with the user's original prompt.
                const idx = messages.findIndex((x) => x.id === target.id);
                if (idx <= 0) return;
                const userTurn = messages[idx - 1];
                if (userTurn.role !== 'user') return;
                setMessages((list) =>
                  list.filter((x) => x.id !== target.id && x.id !== userTurn.id),
                );
                setInput(userTurn.content);
                setAttachments(userTurn.attachments ?? []);
                // Defer so state settles before re-sending.
                setTimeout(() => sendCommand(userTurn.command ?? 'chat', userTurn.content), 0);
              }}
              onRestoreCheckpoint={async (id) => {
                if (!workspaceRoot || !window.suxai.checkpoint?.restore) {
                  toast.error('Restore unavailable', 'No workspace open.');
                  return;
                }
                try {
                  const r = await window.suxai.checkpoint.restore(workspaceRoot, id);
                  toast.success(
                    `Restored ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}`,
                    'Workspace rolled back to its pre-turn state.',
                  );
                  // Reload any restored file that's currently open so
                  // the editor doesn't keep showing stale post-edit
                  // content. We re-read each one then re-openFile to
                  // swap content + clear dirty.
                  for (const abs of r.restored) {
                    const target = openFiles.find((f) => f.path === abs);
                    if (!target) continue;
                    try {
                      const fresh = await window.suxai.fs.readFile(abs);
                      openFile({ ...target, content: fresh.content, dirty: false });
                    } catch (err) {
                      console.warn('[restore] could not refresh', abs, err);
                    }
                  }
                } catch (err) {
                  toast.error('Restore failed', (err as Error).message);
                }
              }}
            />
          ))
        )}
      </div>

      {showJump && (
        <button
          type="button"
          className="ai__jump"
          onClick={jumpToBottom}
          aria-label="Jump to latest"
          title="Jump to latest"
        >
          <AtelierIcon name="i-chevron-down" size={14} />
        </button>
      )}

      {/* v0.16.4 — Plan-mode banner above the composer. When mode === 'ask'
          the agent is read-only and can ONLY call read_file / list_dir /
          grep / codebase_search / create_plan. Without this banner, users
          accidentally toggle Plan mode, then ask the agent to edit a file,
          and wonder why it "only thinks + reads but never modifies". One
          click on the X (or the Plan toggle in the header) flips mode
          back to 'composer' and edits resume. */}
      {activeConv?.mode === 'ask' && (
        <div className="ai__plan-banner" role="note">
          <span className="ai__plan-banner-icon" aria-hidden>
            <AtelierIcon name="i-suggestion" size={14} />
          </span>
          <span className="ai__plan-banner-text">
            <strong>Plan mode</strong> · read-only (no file edits, no commands).
            The agent will write a plan to <code>.suxai/plans/</code>.
          </span>
          <button
            type="button"
            className="ai__plan-banner-close"
            onClick={() => {
              if (!activeConvId) return;
              setConversations((list) =>
                list.map((c) =>
                  c.id === activeConvId ? { ...c, mode: 'composer' } : c,
                ),
              );
              toast.info('Plan mode OFF', 'Agent can now edit files and run commands.');
            }}
            title="Disable Plan mode"
            aria-label="Disable Plan mode"
          >
            <AtelierIcon name="i-close" size={11} />
          </button>
        </div>
      )}
      <form
        className={`ai__composer ${dragOver ? 'ai__composer--dragover' : ''} ${streaming ? 'ai__composer--streaming' : ''}`}
        onDragOver={(e) => {
          // Accept drags carrying our custom payload (sidebar entry)
          // OR a plain file path (legacy text/uri-list, OS file drop).
          const types = e.dataTransfer.types;
          if (
            types.includes('text/x-suxai-path') ||
            types.includes('Files') ||
            types.includes('text/uri-list')
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!dragOver) setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          // Only clear when the cursor leaves the composer entirely,
          // not when it crosses an inner child.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragOver(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDragOver(false);
          const sidebarPath = e.dataTransfer.getData('text/x-suxai-path');
          const candidates: string[] = [];
          if (sidebarPath) candidates.push(sidebarPath);
          for (const file of Array.from(e.dataTransfer.files)) {
            const p = (file as unknown as { path?: string }).path;
            if (typeof p === 'string' && p) candidates.push(p);
          }
          for (const path of candidates) {
            try {
              const f = await window.suxai.fs.readFile(path);
              const name = f.path.split(/[\\/]/).pop() ?? f.path;
              const adjusted = adjustOversizedAttachment(f.content, name, toast);
              setAttachments((list) =>
                list.some((a) => a.path === f.path)
                  ? list
                  : [...list, { path: f.path, content: adjusted, name }],
              );
            } catch (err) {
              toast.error('Could not attach file', (err as Error).message);
            }
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          // Try built-in local commands FIRST (/clear, /help, /plan…)
          // — they short-circuit before the LLM is contacted at all.
          if (handleBuiltinSlash(input)) return;
          const slash = parseSlashCommand(input);
          if (slash) {
            sendCommand(slash.cmd, slash.rest);
          } else {
            sendCommand('chat');
          }
        }}
      >
        {attachments.length > 0 && (
          <div className="ai__attachments">
            {attachments.map((a) => (
              <span key={a.path} className="ai__attach" title={a.path}>
                <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
                  <path
                    d="M7.5 3.5v-2a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3.5H7.5zM7.5 0.5 9 2.5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="ai__attach-name">{a.name}</span>
                <button
                  type="button"
                  className="ai__attach-x"
                  onClick={() =>
                    setAttachments((list) => list.filter((x) => x.path !== a.path))
                  }
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoResize(e.currentTarget);
          }}
          placeholder={
            token
              ? 'Ask anything — slash commands (/explain, /refactor, /fix, /optimize) and @file mentions work here'
              : 'Sign in to use AI'
          }
          rows={1}
          disabled={!token || streaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              // Plain Enter sends; Shift+Enter inserts a newline.
              e.preventDefault();
              if (handleBuiltinSlash(input)) return;
              const slash = parseSlashCommand(input);
              if (slash) sendCommand(slash.cmd, slash.rest);
              else sendCommand('chat');
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              // Cmd/Ctrl+Enter still works as the explicit "send" combo
              // for users used to it.
              e.preventDefault();
              if (handleBuiltinSlash(input)) return;
              const slash = parseSlashCommand(input);
              if (slash) sendCommand(slash.cmd, slash.rest);
              else sendCommand('chat');
            }
          }}
        />
        <div className="ai__composer-row">
          <div className="ai__composer-meta">
            {activeFile ? (
              <>
                <span className="ai__chip">{activeFile.name}</span>
                {selection && <span className="ai__chip ai__chip--accent">selection</span>}
              </>
            ) : (
              <span className="ai__composer-hint">No file — chat only</span>
            )}
            <TokenUsageBar />
          </div>
          <button
            type="button"
            className="ai__attach-btn"
            onClick={async () => {
              const f = await window.suxai.fs.openFile();
              if (!f) return;
              const name = f.path.split(/[\\/]/).pop() ?? f.path;
              const adjusted = adjustOversizedAttachment(f.content, name, toast);
              setAttachments((list) =>
                list.some((a) => a.path === f.path)
                  ? list
                  : [...list, { path: f.path, content: adjusted, name }],
              );
            }}
            disabled={!token || streaming}
            title="Attach file as context"
          >
            <svg width="14" height="16" viewBox="0 0 14 16" fill="none" aria-hidden>
              <path
                d="M10.5 6 5.5 11a2.5 2.5 0 1 1-3.5-3.5L8 1.5a4 4 0 0 1 5.5 5.5L7.5 13"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {streaming ? (
            <Button type="button" variant="secondary" size="sm" onClick={stop} leftIcon={<Spinner size={12} />}>
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="sm" disabled={!token || !input.trim()}>
              Send
            </Button>
          )}
        </div>
      </form>
      <ApprovalDialog request={approval} />
    </aside>
  );
}
