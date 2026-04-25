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
import { AGENT_TOOLS, executeTool, type ToolCall } from '../../lib/agent';
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
// tool_use/tool_result pairs. Anthropic rejects a transcript that ends
// (or starts) with a tool_use missing its tool_result, or vice versa.
// We always keep:
//   1. The very first user message (kicks the conversation off; if we
//      drop it, the model loses task framing).
//   2. The last MAX_AGENT_MESSAGES messages — but if the slice would
//      cut between a tool_use turn and the tool_result turn that
//      follows, we shift the cut earlier.
const MAX_AGENT_MESSAGES = 40;
function trimAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= MAX_AGENT_MESSAGES) return messages;
  const first = messages[0];
  let cut = messages.length - MAX_AGENT_MESSAGES;
  // If the first kept message is a "user" turn whose content is purely
  // tool_result blocks, that orphans the previous tool_use. Walk forward
  // until we land on a regular user/assistant boundary.
  while (cut < messages.length) {
    const m = messages[cut];
    const isToolResultOnly =
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.every((b) => (b as { type?: string }).type === 'tool_result');
    if (!isToolResultOnly) break;
    cut++;
  }
  const tail = messages.slice(cut);
  // Re-prepend the original opening message so the model still sees the
  // task framing. If the head is identical to tail[0], skip the dup.
  if (tail.length > 0 && first === tail[0]) return tail;
  return [first, ...tail];
}

interface AgentLoopArgs {
  token: string;
  modelId: string;
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
  ) => Promise<boolean>;
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
          tools: AGENT_TOOLS,
          agentMessages,
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

    if (collectedTools.length === 0 || stopReason !== 'tool_use') {
      // Conversation ended naturally.
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
  const { activeFile, selection, updateActiveContent, openDiff, openFiles, workspaceRoot } = useWorkspace();
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

  const requestApproval = useCallback(
    (
      call: ToolCall,
      preview?: { path: string; original: string; proposed: string },
    ): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setApproval({
          call,
          preview,
          resolve: (approved) => {
            setApproval(null);
            resolve(approved);
          },
        });
      }),
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

  // Extract @path/to/file mentions from the composer and read their content
  // so the AI gets them as explicit context. Returns the cleaned prompt
  // (without the @-mentions) and the loaded attachments.
  const extractMentions = useCallback(
    async (raw: string): Promise<{ cleaned: string; attachments: { path: string; content: string }[] }> => {
      // Match everything after an @ until whitespace / newline / another @.
      // Previous version stopped at multi-dot file names ('file.test.ts').
      const re = /@([^\s@\n]+)/g;
      const matches = [...raw.matchAll(re)];
      if (matches.length === 0) return { cleaned: raw, attachments: [] };
      const attachments: { path: string; content: string }[] = [];
      for (const m of matches) {
        const ref = m[1];
        // Try a few candidate resolutions before giving up:
        //   1. treat as an absolute path
        //   2. treat as a bare filename and match against open files
        let resolved: { path: string; content: string } | null = null;
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
            /* can't find — ignore, the raw @mention stays in the prompt */
          }
        }
        if (resolved) attachments.push(resolved);
      }
      const cleaned = raw.replace(re, '').replace(/\s+/g, ' ').trim();
      return { cleaned, attachments };
    },
    [openFiles],
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
      const fullPromptForHistory =
        buildCommandPrompt(command, cleaned || selection || activeFile?.content || '') +
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
      const diffTarget =
        command === 'fix' || command === 'refactor' || command === 'optimize'
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
        // Load AGENTS.md/CLAUDE.md once per workspace and reuse the
        // string across iterations — avoids repeated FS reads and
        // keeps the prompt prefix stable for Anthropic caching.
        let preamble = '';
        if (preambleRef.current?.root === workspaceRoot) {
          preamble = preambleRef.current.preamble;
        } else {
          preamble = await loadProjectPreamble(workspaceRoot);
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
        runAgentLoop({
          token,
          modelId,
          firstUserMsg: userMsg,
          firstAssistantMsg: assistantMsg,
          conversationMessages: [...messages, userMsg, assistantMsg],
          preamble,
          setMessages,
          setStreaming,
          abortRef,
          toast,
          requestApproval,
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
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantMsg.id ? { ...msg, streaming: false } : msg)),
            );
            setStreaming(false);
            abortRef.current = null;

            // Auto-open diff for fix/refactor/optimize commands when the
            // response contains at least one code block. User-friendly:
            // same experience as Cursor's edit-and-accept flow.
            if (diffTarget) {
              const proposed = extractFirstCodeBlock(full);
              if (proposed && proposed.trim() !== diffTarget.content.trim()) {
                openDiff({
                  path: diffTarget.path,
                  original: diffTarget.content,
                  proposed,
                  label: `${command} · ${modelId}`,
                });
              }
            }
          },
          onError: (err) => {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantMsg.id
                  ? { ...msg, streaming: false, error: err.message }
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
      updateActiveContent(code);
    },
    [activeFile, updateActiveContent],
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
                  c.id === activeConvId ? { ...c, agentMode: !c.agentMode } : c,
                ),
              );
            }}
            title="Agent mode lets the AI read and edit files itself, with your approval"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 2v4m0 12v4M4 12H2m20 0h-2M5 5l3 3m8 8 3 3M5 19l3-3m8-8 3-3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            Agent {activeConv?.agentMode ? 'on' : 'off'}
          </button>
        </div>
        <button
          className="ai__clear"
          onClick={newConversation}
          title="New conversation"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
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
        className="ai__composer"
        onSubmit={(e) => {
          e.preventDefault();
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
              const slash = parseSlashCommand(input);
              if (slash) sendCommand(slash.cmd, slash.rest);
              else sendCommand('chat');
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              // Cmd/Ctrl+Enter still works as the explicit "send" combo
              // for users used to it.
              e.preventDefault();
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
          </div>
          <button
            type="button"
            className="ai__attach-btn"
            onClick={async () => {
              const f = await window.suxai.fs.openFile();
              if (!f) return;
              const name = f.path.split(/[\\/]/).pop() ?? f.path;
              setAttachments((list) =>
                list.some((a) => a.path === f.path)
                  ? list
                  : [...list, { path: f.path, content: f.content, name }],
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
