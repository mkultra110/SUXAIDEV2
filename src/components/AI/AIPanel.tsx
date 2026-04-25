import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { streamAi, buildCommandPrompt, type AiCommand } from '../../api/quatarly';
import { AI_MODELS, DEFAULT_MODEL_ID } from '../../config';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Message, type ChatMessage } from './Message';
import { ModelSelector } from './ModelSelector';
import { ConversationSwitcher } from './ConversationSwitcher';
import { onAiCommand } from '../../lib/commands';
import {
  emptyConversation,
  deriveTitle,
  loadConversations,
  saveConversations,
  type Conversation,
} from '../../lib/conversations';
import { useToast } from '../ui/Toast';
import './AIPanel.css';

const STORAGE_MODEL_KEY = 'suxai.model';
const MAX_PERSISTED_MESSAGES = 200;

/** Pull the first fenced code block out of a streamed response. */
function extractFirstCodeBlock(text: string): string | null {
  const m = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  return m ? m[1] : null;
}

export function AIPanel() {
  const { token } = useAuth();
  const { activeFile, selection, updateActiveContent, openDiff, openFiles } = useWorkspace();
  const [modelId, setModelId] = useState<string>(() => {
    return localStorage.getItem(STORAGE_MODEL_KEY) || DEFAULT_MODEL_ID;
  });
  const [input, setInput] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [attachments, setAttachments] = useState<{ path: string; content: string; name: string }[]>([]);
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

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

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        command,
        content:
          command === 'chat'
            ? cleaned || text
            : `${command.toUpperCase()}${cleaned ? `: ${cleaned}` : ''}`,
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

      // Merge explicit attachments (paperclip button) with @-mention
      // attachments — de-dup by path.
      const seen = new Set(attachments.map((a) => a.path));
      const merged = [
        ...attachments.map((a) => ({ path: a.path, content: a.content })),
        ...resolvedMentions.filter((a) => !seen.has(a.path)),
      ];

      const attachmentBlock =
        merged.length > 0
          ? merged
              .map((a) => `\n\n<<< FILE: ${a.path} >>>\n${a.content}\n<<< END >>>`)
              .join('')
          : '';

      const prompt =
        buildCommandPrompt(command, cleaned || selection || activeFile?.content || '') +
        attachmentBlock;

      // Snapshot the target file at send-time — if the user switches tabs
      // mid-stream, we still diff against the file they asked about.
      const diffTarget =
        command === 'fix' || command === 'refactor' || command === 'optimize'
          ? activeFile
          : null;

      // Include the prior turns of THIS conversation so the model stays
      // coherent across follow-ups. We strip streaming/error metadata
      // and cap to the last 20 turns to keep the request manageable.
      const history = messages
        .filter((m) => !m.streaming && !m.error && m.content.trim().length > 0)
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

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
    [token, input, selection, activeFile, modelId, extractMentions, attachments, messages],
  );

  const stop = () => {
    abortRef.current?.();
    abortRef.current = null;
    setStreaming(false);
    setMessages((m) =>
      m.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)),
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
      if (
        !window.confirm(
          'Delete this conversation? Its history will be removed and the AI will not remember it.',
        )
      ) {
        return;
      }
      setConversations((list) => {
        const next = list.filter((c) => c.id !== id);
        if (id === activeConvId) {
          abortRef.current?.();
          setStreaming(false);
          // Switch to next available conversation, or create a fresh one.
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
            onRename={renameConversation}
          />
          <ModelSelector value={modelId} onChange={setModelId} />
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

      <div className="ai__messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="ai__empty">
            <div className="ai__empty-badge">{selectedModel.label}</div>
            <h3>Ready when you are</h3>
            <p>
              Ask a question, or use a command above. The AI sees your active file and any selected code —
              never your entire project.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <Message key={m.id} message={m} onApply={onApplyCode} onDiff={onDiffCode} />
          ))
        )}
      </div>

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
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            token
              ? 'Ask anything — slash commands (/explain, /refactor, /fix, /optimize) and @file mentions work here'
              : 'Sign in to use AI'
          }
          rows={3}
          disabled={!token || streaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
    </aside>
  );
}
