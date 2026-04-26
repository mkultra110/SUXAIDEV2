import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { streamAi, buildCommandPrompt, type AiCommand } from '../../api/quatarly';
import { AI_MODELS, DEFAULT_MODEL_ID } from '../../config';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Message, type ChatMessage, type ToolCallSnapshot } from './Message';
import { ModelSelector } from './ModelSelector';
import { ConversationSwitcher } from './ConversationSwitcher';
import { ApprovalDialog, type ApprovalRequest } from './ApprovalDialog';
import { onAiCommand } from '../../lib/commands';
import {
  emptyConversation,
  deriveTitle,
  loadConversations,
  saveConversations,
  type Conversation,
} from '../../lib/conversations';
import { executeTool, toolsForMode, type ToolCall } from '../../lib/agent';
import { buildAdditionalDataXml } from '../../lib/additional-data';
import { buildRepoMap, formatRepoMapBlock } from '../../lib/repo-map';
import { TokenUsageBar } from './TokenUsageBar';
import type { AgentMessage, AgentContentBlock } from '../../api/quatarly';
import { useToast } from '../ui/Toast';
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
    const completed = (m.toolCalls ?? []).filter(
      (tc) => tc.result !== undefined && tc.status !== 'pending' && tc.status !== 'running',
    );
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
}

async function runAgentLoop(args: AgentLoopArgs): Promise<void> {
  const { token, modelId, firstAssistantMsg, conversationMessages, setMessages, setStreaming, abortRef, toast } = args;

  let currentAssistantId = firstAssistantMsg.id;
  // Working copy of the conversation messages — mirrors what we'll push
  // to the panel's state. Built from the initial snapshot, then we
  // reflect every state mutation locally so chatToAgentMessages always
  // sees the freshest payload.
  let working = conversationMessages.slice();

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

    await new Promise<void>((resolve, reject) => {
      const cancel = streamAi(
        token,
        {
          modelId,
          command: 'chat',
          prompt: '',
          // Mode-aware tool list: ask mode drops edit_file/write_file/
          // run_command and adds create_plan; composer keeps the full
          // write-capable surface. Computed per turn so toggling Plan
          // mid-conversation takes effect immediately.
          tools: toolsForMode(args.mode),
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
          // v0.12: stash thinking + redacted_thinking + server_tool_use
          // blocks on the assistant message so chatToAgentMessages can
          // round-trip them byte-for-byte on the next iteration.
          // Required by Anthropic on *-thinking model variants.
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
    if (stopReason === 'pause_turn') {
      // v0.12.3 (audit #10): Anthropic emits pause_turn when a
      // long-running server-side tool (web_search, container) needs
      // to suspend the turn but isn't done. Spec says: re-send the
      // assistant content verbatim and continue the loop. Our
      // chatToAgentMessages already round-trips assistantBlocks +
      // text + tool_use byte-for-byte, so we just spawn a fresh
      // assistant turn and loop without executing tools (there are
      // none to execute — pause_turn never coexists with tool_use).
      const nextPause: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        streaming: true,
        modelId,
      };
      setMessages((m) => {
        const updated = [...m, nextPause];
        working = updated;
        return updated;
      });
      currentAssistantId = nextPause.id;
      continue;
    }
    if (collectedTools.length === 0 || stopReason !== 'tool_use') {
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
        try {
          const result = await executeTool(call, {
            approve: (c, preview) => args.requestApproval(c, preview),
            workspaceRoot: args.workspaceRoot ?? null,
            applyLazyEdit: args.applyLazyEdit,
          });
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
        const isFileWrite = call.name === 'edit_file' || call.name === 'write_file';
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
  useEffect(() => {
    if (!activeConv) return;
    const totalChars = activeConv.messages.reduce(
      (acc, m) => acc + (m.historyContent?.length ?? m.content.length),
      0,
    );
    const approxTokens = Math.round(totalChars / 4);
    // v0.12.5 (audit #9): per-model context window. Sonnet/Haiku 4.x
    // = 200K tokens, Opus 4.x = 200K, but interleaved-thinking and
    // future bumps can push to 1M. Trigger compaction at 70 % of the
    // *current model's* window — without this, switching to a 400K
    // model fired the warning at 35 % usage. Keep a safe 200K
    // default for unknown IDs.
    const ctxByModel: Record<string, number> = {
      'claude-opus-4-6-thinking': 400_000,
      'claude-sonnet-4-6-thinking': 200_000,
      'claude-haiku-4-5-20251001': 200_000,
    };
    const ctxWindow = ctxByModel[modelId] ?? 200_000;
    const WARN_AT = Math.floor(ctxWindow * 0.7);
    if (approxTokens > WARN_AT && warnedAtRef.current < WARN_AT) {
      warnedAtRef.current = approxTokens;
      toast.info(
        `Conversation getting long (~${Math.round(approxTokens / 1000)}K tokens)`,
        'Type /compact to summarise older messages and free up context.',
      );
    }
    // Reset the guard when the conversation shrinks (e.g. after
    // /compact runs).
    if (approxTokens < WARN_AT * 0.8) warnedAtRef.current = 0;
  }, [activeConv, modelId, toast]);

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
              '- `/clear` — wipe this conversation\n' +
              '- `/help` — this list\n' +
              '- `/plan` — toggle Plan mode (read-only investigation, produces a markdown plan)\n' +
              '- `/agent` — toggle Agent mode (lets Claude read/edit your files)\n' +
              '- `/model` — open the model selector\n' +
              '- `/explain`, `/refactor`, `/fix`, `/optimize` — task shortcuts on the current file/selection\n\n' +
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
      const re = /@([a-zA-Z_][\w-]*|[^\s@\n]+)/g;
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
          default: {
            // File mention — try open files first, then read from disk.
            const open = openFiles.find(
              (f) => f.path.endsWith(ref) || f.name === ref,
            );
            if (open) {
              resolved = { path: open.path, content: open.content };
            } else {
              try {
                const r = await window.suxai.fs.readFile(ref);
                resolved = r;
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
      let cleaned = raw;
      for (const c of consumed) {
        cleaned = cleaned.replace(c, '');
      }
      cleaned = cleaned.replace(/\s+/g, ' ').trim();
      return { cleaned, attachments };
    },
    [openFiles, selection, activeFile, editorContext, workspaceRoot],
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
        }).catch((err) => {
          console.error('[agent] loop failed:', err);
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantMsg.id
                ? { ...msg, streaming: false, error: (err as Error).message }
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
    (code: string) => {
      if (!activeFile) return;
      // Open the diff view instead of overwriting the buffer outright.
      // The model usually returns just the modified snippet — replacing
      // the whole file with that snippet would silently delete every
      // surrounding line. The diff view lets the user accept hunks
      // individually (or hit "Accept all" to replace fully on purpose).
      openDiff({
        path: activeFile.path,
        original: activeFile.content,
        proposed: code,
        label: `apply · ${modelId}`,
      });
    },
    [activeFile, openDiff, modelId],
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
        <div className="ai__header-main">
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
        <div className="ai__header-actions">
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
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M9 5H4v14h16V9h-5M9 5l5 5h6"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
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
            className="ai__clear"
            onClick={newConversation}
            title="New conversation"
            aria-label="New conversation"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
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
                  <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#7d82f8" />
                    <stop offset="100%" stopColor="#5457d8" />
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      <form
        className={`ai__composer ${dragOver ? 'ai__composer--dragover' : ''}`}
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
