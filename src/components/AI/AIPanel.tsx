import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { streamAi, buildCommandPrompt, type AiCommand } from '../../api/quatarly';
import { AI_MODELS, DEFAULT_MODEL_ID } from '../../config';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { Message, type ChatMessage } from './Message';
import { ModelSelector } from './ModelSelector';
import { onAiCommand } from '../../lib/commands';
import './AIPanel.css';

const STORAGE_MODEL_KEY = 'suxai.model';
const MAX_PERSISTED_MESSAGES = 200;

export function AIPanel() {
  const { token } = useAuth();
  const { activeFile, selection, updateActiveContent, openDiff, openFiles } = useWorkspace();
  const [modelId, setModelId] = useState<string>(() => {
    return localStorage.getItem(STORAGE_MODEL_KEY) || DEFAULT_MODEL_ID;
  });
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedModel = useMemo(
    () => AI_MODELS.find((m) => m.id === modelId) ?? AI_MODELS[0],
    [modelId],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_MODEL_KEY, modelId);
  }, [modelId]);

  // Load persisted conversation once at mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = (await window.suxai.conversations.read()) as ChatMessage[];
        if (!cancelled && Array.isArray(stored) && stored.length > 0) {
          // Drop any lingering streaming flag from the previous session.
          setMessages(stored.map((m) => ({ ...m, streaming: false })));
        }
      } catch (err) {
        console.warn('[conv] load failed:', err);
      } finally {
        if (!cancelled) setHistoryLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on change (debounced). Keep last N messages only to cap disk growth.
  useEffect(() => {
    if (!historyLoaded) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const trimmed = messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => ({
        ...m,
        streaming: false,
      }));
      window.suxai.conversations.write(trimmed).catch((err) => {
        console.warn('[conv] save failed:', err);
      });
    }, 400);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [messages, historyLoaded]);

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
      const re = /@([^\s@]+(?:\.\w+)?)/g;
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
      const { cleaned, attachments } = await extractMentions(text);

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
      setStreaming(true);

      const attachmentBlock =
        attachments.length > 0
          ? attachments
              .map((a) => `\n\n<<< FILE: ${a.path} >>>\n${a.content}\n<<< END >>>`)
              .join('')
          : '';

      const prompt =
        buildCommandPrompt(command, cleaned || selection || activeFile?.content || '') +
        attachmentBlock;

      const cancel = streamAi(
        token,
        {
          modelId,
          command,
          prompt,
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
          onDone: () => {
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantMsg.id ? { ...msg, streaming: false } : msg)),
            );
            setStreaming(false);
            abortRef.current = null;
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
    [token, input, selection, activeFile, modelId, extractMentions],
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

  const clear = () => {
    abortRef.current?.();
    setMessages([]);
    window.suxai.conversations.clear().catch(() => {});
  };

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
          <div className="ai__title">
            <span className="ai__title-dot" />
            AI Assistant
          </div>
          <ModelSelector value={modelId} onChange={setModelId} />
        </div>
        <button className="ai__clear" onClick={clear} disabled={messages.length === 0} title="New conversation">
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
