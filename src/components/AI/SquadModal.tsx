import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSettings } from '../../lib/settings';
import { useToast } from '../ui/Toast';
import { AtelierIcon } from '../ui/AtelierIcon';
import {
  runSquad,
  SQUAD_AGENTS,
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
  const abortRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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
    // Clear previous states so the cards reset cleanly.
    setStates(new Map());
    setRunning(true);
    let doneCount = 0;
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
      onUpdate: (s) => {
        setStates((prev) => {
          const next = new Map(prev);
          next.set(s.spec.id, s);
          return next;
        });
        if (s.status === 'done' || s.status === 'error') {
          doneCount++;
          if (doneCount >= SQUAD_AGENTS.length) {
            setRunning(false);
            abortRef.current = null;
          }
        }
      },
    });
  }, [token, running, prompt, settings.defaultModelId, activeFile, toast]);

  const cancel = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setRunning(false);
  }, []);

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
              {SQUAD_AGENTS.length} agents en parallèle
              {activeFile ? ` · scope : ${activeFile.name}` : ' · pas de fichier actif'}
            </div>
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
              Cancel ({totalDone}/{SQUAD_AGENTS.length})
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
          {SQUAD_AGENTS.map((spec) => (
            <AgentColumn key={spec.id} spec={spec} state={states.get(spec.id)} />
          ))}
        </div>

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
}: {
  spec: SquadAgentSpec;
  state: SquadAgentState | undefined;
}) {
  const status = state?.status ?? 'queued';
  const content = state?.content ?? '';
  const elapsed = state?.startedAt
    ? ((state.doneAt ?? Date.now()) - state.startedAt) / 1000
    : 0;
  return (
    <div className={`squad-col squad-col--${spec.accent} squad-col--${status}`}>
      <header className="squad-col__head">
        <span className="squad-col__glyph" aria-hidden>{spec.glyph}</span>
        <span className="squad-col__label">{spec.label}</span>
        <span className={`squad-col__status squad-col__status--${status}`}>
          {status === 'queued'    ? 'queued' :
           status === 'streaming' ? `${elapsed.toFixed(1)}s` :
           status === 'done'      ? `done · ${elapsed.toFixed(1)}s` :
           status === 'error'     ? 'error' : status}
        </span>
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
