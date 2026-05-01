import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSettings } from '../../lib/settings';
import { useToast } from '../ui/Toast';
import { AtelierIcon } from '../ui/AtelierIcon';
import {
  runSquad,
  runMaster,
  SQUAD_AGENTS,
  SQUAD_MASTER,
  type SquadAgentSpec,
  type SquadAgentState,
} from '../../lib/squad';
import './SquadModal.css';

/**
 * v4.0 — Squad multi-agent audit modal.
 *
 * Opened via Command Palette « AI: Run Squad Audit… » or via
 * `suxai:open-squad` event. Shows N agents (architect, auditor,
 * improver) running in parallel on the active file's content + the
 * user's prompt. Each agent streams its response live in a
 * dedicated card, color-coded by role.
 *
 * No master synthesis in V4.0 — chaque agent est indépendant ; le
 * user lit les 3 reports et décide ce qui s'applique. Master
 * synthesis = potentiel V4.1.
 */

const SQUAD_OPEN_EVENT = 'suxai:open-squad';

export function openSquad(): void {
  window.dispatchEvent(new CustomEvent(SQUAD_OPEN_EVENT));
}

export function SquadModal() {
  const { token } = useAuth();
  const { activeFile } = useWorkspace();
  const [settings] = useSettings();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [states, setStates] = useState<Map<string, SquadAgentState>>(() => new Map());
  // v4.1 — toggle individual agents on/off avant le run. Defaults
  // = tous activés. Stocké dans un Set d'IDs pour dedup easy.
  const [enabled, setEnabled] = useState<Set<string>>(
    () => new Set(SQUAD_AGENTS.map((a) => a.id)),
  );
  // v4.1 — toggle master synthesis. Default true. Si on, fire
  // automatiquement après que tous les role agents sont done.
  const [withMaster, setWithMaster] = useState(true);
  const abortRef = useRef<(() => void) | null>(null);
  const masterAbortRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // v4.1 — keep the last user prompt around so the master synth
  // (which fires AFTER the user has finished typing) can pass it
  // along to the meta-agent.
  const lastPromptRef = useRef('');
  // v4.2 — synchronous bookkeeping for the squad run. Refs avoid
  // (a) closure staleness when `start` is recreated mid-stream and
  // (b) the side-effect-inside-state-updater pitfall (React may
  // invoke a setState updater twice in StrictMode, which would
  // double-fire runMaster). The ref-based map gives us an instant
  // snapshot of every agent's terminal content so we can build the
  // master prompt without racing React's commit cycle.
  const doneCountRef = useRef(0);
  const finalContentRef = useRef<Map<string, SquadAgentState>>(new Map());

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(SQUAD_OPEN_EVENT, handler);
    return () => window.removeEventListener(SQUAD_OPEN_EVENT, handler);
  }, []);

  // Esc cancels any in-flight squad + closes the modal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (running) {
          abortRef.current?.();
          setRunning(false);
        } else {
          setOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, running]);

  // Focus the prompt input on open.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Default prompt suggests a file scope when one is active.
  useEffect(() => {
    if (open && !prompt.trim()) {
      const name = activeFile?.name;
      setPrompt(
        name
          ? `Audit ${name} from your role's perspective. What stands out?`
          : 'Review the conversation context and propose improvements from your role.',
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const start = useCallback(() => {
    if (!token) {
      toast.error('Not authenticated', 'Sign in to use the Squad.');
      return;
    }
    if (running) return;
    if (!prompt.trim()) {
      toast.info('Empty prompt', 'Tell the Squad what to look at.');
      return;
    }
    const activeAgents = SQUAD_AGENTS.filter((a) => enabled.has(a.id));
    if (activeAgents.length === 0) {
      toast.info('No agents enabled', 'Toggle at least one agent before running.');
      return;
    }
    // Clear previous states so the cards reset cleanly.
    setStates(new Map());
    setRunning(true);
    lastPromptRef.current = prompt.trim();
    // v4.2 — reset the synchronous bookkeeping for this run.
    doneCountRef.current = 0;
    finalContentRef.current = new Map();
    abortRef.current = runSquad({
      token,
      modelId: settings.defaultModelId,
      prompt: prompt.trim(),
      context: activeFile
        ? {
            filePath: activeFile.path,
            language: activeFile.language,
            fileContent: activeFile.content,
          }
        : undefined,
      agents: activeAgents,
      onUpdate: (s) => {
        setStates((prev) => {
          const next = new Map(prev);
          next.set(s.spec.id, s);
          return next;
        });
        if (s.status === 'done' || s.status === 'error') {
          // v4.2 — track terminal state synchronously via refs so
          // (a) the counter survives StrictMode re-renders and
          // (b) we can build the master prompt without reading React
          // state mid-update.
          finalContentRef.current.set(s.spec.id, s);
          doneCountRef.current += 1;
          if (doneCountRef.current >= activeAgents.length) {
            abortRef.current = null;
            if (withMaster) {
              const reports: Array<{ spec: SquadAgentSpec; content: string }> = [];
              for (const a of activeAgents) {
                const st = finalContentRef.current.get(a.id);
                if (st && st.status === 'done' && st.content.trim()) {
                  reports.push({ spec: a, content: st.content });
                }
              }
              if (reports.length === 0) {
                setRunning(false);
                return;
              }
              masterAbortRef.current = runMaster({
                token,
                modelId: settings.defaultModelId,
                userPrompt: lastPromptRef.current,
                reports,
                onUpdate: (ms) => {
                  setStates((p) => {
                    const next = new Map(p);
                    next.set(ms.spec.id, ms);
                    return next;
                  });
                  if (ms.status === 'done' || ms.status === 'error') {
                    masterAbortRef.current = null;
                    setRunning(false);
                  }
                },
              });
            } else {
              setRunning(false);
            }
          }
        }
      },
    });
  }, [token, running, prompt, settings.defaultModelId, activeFile, toast, enabled, withMaster]);

  const cancel = useCallback(() => {
    abortRef.current?.();
    masterAbortRef.current?.();
    abortRef.current = null;
    masterAbortRef.current = null;
    setRunning(false);
  }, []);

  // v4.1 — toggle un agent on/off avant le run.
  const toggleAgent = useCallback((id: string) => {
    if (running) return;
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [running]);

  // v4.1 — envoie le report d'un agent dans le chat principal AI.
  // Le report devient le prompt initial d'une nouvelle conversation,
  // utile pour creuser un point précis avec follow-ups.
  const sendToChat = useCallback((state: SquadAgentState) => {
    if (!state.content.trim()) {
      toast.info('Empty report', 'Nothing to send to chat.');
      return;
    }
    const header = `From Squad ${state.spec.glyph} **${state.spec.label}**` +
      (activeFile ? ` on \`${activeFile.name}\`` : '') + ' :\n\n';
    window.dispatchEvent(
      new CustomEvent<{ text: string }>('suxai:add-to-chat', {
        detail: { text: header + state.content },
      }),
    );
    toast.success('Sent to chat', `${state.spec.label}'s report queued in the AI panel composer.`);
    setOpen(false);
  }, [activeFile, toast]);

  const totalDone = useMemo(
    () => Array.from(states.values()).filter((s) => s.status === 'done' || s.status === 'error').length,
    [states],
  );

  if (!open) return null;

  return createPortal(
    <div
      className="squad__overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!running) setOpen(false);
      }}
    >
      <div
        className="squad glass-strong"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="squad__head">
          <span className="squad__head-icon" aria-hidden>
            <AtelierIcon name="i-brain" size={16} />
          </span>
          <div className="squad__head-text">
            <div className="squad__title">Squad audit</div>
            <div className="squad__subtitle">
              {enabled.size} of {SQUAD_AGENTS.length} agents
              {withMaster ? ' + master' : ''}
              {activeFile ? ` · scope : ${activeFile.name}` : ' · pas de fichier actif'}
            </div>
          </div>
          {/* v4.1 — toggles agents + master à droite du header. */}
          <div className="squad__agent-toggles" role="group" aria-label="Enable agents">
            {SQUAD_AGENTS.map((spec) => {
              const on = enabled.has(spec.id);
              return (
                <button
                  key={spec.id}
                  type="button"
                  className={`squad__agent-toggle squad__agent-toggle--${spec.accent} ${on ? 'is-on' : ''}`}
                  onClick={() => toggleAgent(spec.id)}
                  disabled={running}
                  title={`${spec.label} — ${on ? 'click to disable' : 'click to enable'}`}
                >
                  <span aria-hidden>{spec.glyph}</span>
                  <span className="squad__agent-toggle-label">{spec.label}</span>
                </button>
              );
            })}
            <button
              type="button"
              className={`squad__agent-toggle squad__agent-toggle--bronze ${withMaster ? 'is-on' : ''}`}
              onClick={() => !running && setWithMaster((v) => !v)}
              disabled={running}
              title={`Master synthesis — ${withMaster ? 'click to disable' : 'click to enable'}`}
            >
              <span aria-hidden>{SQUAD_MASTER.glyph}</span>
              <span className="squad__agent-toggle-label">Master</span>
            </button>
          </div>
          <button
            type="button"
            className="squad__close"
            onClick={() => {
              if (running) cancel();
              setOpen(false);
            }}
            aria-label="Close"
            title="Close (Esc)"
          >
            <AtelierIcon name="i-close" size={13} />
          </button>
        </header>

        <div className="squad__prompt-row">
          <textarea
            ref={inputRef}
            className="squad__prompt"
            placeholder="What should the squad look at?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!running) start();
              }
            }}
            rows={2}
            spellCheck={false}
            disabled={running}
          />
          {running ? (
            <button
              type="button"
              className="squad__run squad__run--cancel"
              onClick={cancel}
              title="Cancel all in-flight streams (Esc)"
            >
              Cancel ({totalDone}/{enabled.size + (withMaster ? 1 : 0)})
            </button>
          ) : (
            <button
              type="button"
              className="squad__run"
              onClick={start}
              title="Run (Ctrl+Enter)"
              disabled={!prompt.trim()}
            >
              <AtelierIcon name="i-sparkle" size={12} />
              Run squad
            </button>
          )}
        </div>

        <div className="squad__grid">
          {SQUAD_AGENTS.filter((a) => enabled.has(a.id)).map((spec) => (
            <AgentColumn
              key={spec.id}
              spec={spec}
              state={states.get(spec.id)}
              onSendToChat={sendToChat}
            />
          ))}
        </div>
        {/* v4.1 — Master synthesis row, full-width sous le grid des
            roles. Visible seulement si l'utilisateur a withMaster on
            ET au moins une running/done state pour Master. */}
        {withMaster && states.has(SQUAD_MASTER.id) && (
          <div className="squad__master-row">
            <AgentColumn
              spec={SQUAD_MASTER}
              state={states.get(SQUAD_MASTER.id)}
              onSendToChat={sendToChat}
              fullWidth
            />
          </div>
        )}

        <footer className="squad__foot">
          <kbd>Ctrl+Enter</kbd> run · <kbd>Esc</kbd> cancel/close · scope = active file content
          {activeFile ? '' : ' (open a file first for context)'}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function AgentColumn({
  spec,
  state,
  onSendToChat,
  fullWidth,
}: {
  spec: SquadAgentSpec;
  state: SquadAgentState | undefined;
  onSendToChat: (state: SquadAgentState) => void;
  fullWidth?: boolean;
}) {
  const status = state?.status ?? 'queued';
  const content = state?.content ?? '';
  const elapsed = state?.startedAt
    ? ((state.doneAt ?? Date.now()) - state.startedAt) / 1000
    : 0;
  const canSend = status === 'done' && content.trim().length > 0;
  return (
    <div
      className={
        `squad-col squad-col--${spec.accent} squad-col--${status}` +
        (fullWidth ? ' squad-col--fullwidth' : '')
      }
    >
      <header className="squad-col__head">
        <span className="squad-col__glyph" aria-hidden>{spec.glyph}</span>
        <span className="squad-col__label">{spec.label}</span>
        <span className={`squad-col__status squad-col__status--${status}`}>
          {status === 'queued'    ? 'queued' :
           status === 'streaming' ? `${elapsed.toFixed(1)}s` :
           status === 'done'      ? `done · ${elapsed.toFixed(1)}s` :
           status === 'error'     ? 'error' : status}
        </span>
        {/* v4.1 — Send to chat (per-agent). Disabled tant que pas
            done. Click → push le report dans le composer AIPanel. */}
        {canSend && state && (
          <button
            type="button"
            className="squad-col__send"
            onClick={() => onSendToChat(state)}
            title={`Send ${spec.label}'s report to the AI chat composer`}
          >
            <AtelierIcon name="i-arrow-up-right" size={11} />
            Send
          </button>
        )}
      </header>
      <div className="squad-col__body">
        {status === 'queued' ? (
          <div className="squad-col__empty">Idle.</div>
        ) : status === 'error' ? (
          <div className="squad-col__error">
            ✗ {state?.error ?? 'unknown error'}
            {content && (
              <pre className="squad-col__partial">{content}</pre>
            )}
          </div>
        ) : (
          <div className="squad-col__content">
            {content || (status === 'streaming' ? '…' : '(empty)')}
            {status === 'streaming' && <span className="squad-col__cursor" aria-hidden>▌</span>}
          </div>
        )}
      </div>
    </div>
  );
}
