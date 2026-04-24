import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace, type OpenFile } from '../../contexts/WorkspaceContext';
import { streamAi, buildCommandPrompt } from '../../api/quatarly';
import { AI_MODELS } from '../../config';
import { useSettings } from '../../lib/settings';
import { Spinner } from '../ui/Spinner';
import './InlineEdit.css';

interface Props {
  /** Viewport-relative anchor for the prompt. */
  top: number;
  left: number;
  width?: number;
  /** The text currently selected (or the current line) in the editor. */
  selectedText: string;
  /** The file we're editing — used for context + where the diff lands. */
  file: OpenFile;
  onClose: () => void;
}

function extractFirstCodeBlock(text: string): string | null {
  const fence = text.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
  if (fence) return fence[1];
  // Some models omit the fence on edit; fall back to the raw text if it
  // looks like pure code (no obvious prose markers).
  if (!/[.?!]\s/.test(text) && !/\n\n/.test(text.trim())) {
    return text;
  }
  return null;
}

export function InlineEdit({ top, left, width, selectedText, file, onClose }: Props) {
  const { token } = useAuth();
  const { openDiff } = useWorkspace();
  const [settings] = useSettings();
  const [prompt, setPrompt] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      abortRef.current?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        abortRef.current?.();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    if (!token) {
      setError('Sign in first');
      return;
    }
    const text = prompt.trim();
    if (!text) return;

    abortRef.current?.();
    setStreaming(true);
    setError(null);

    const instruction = `${text}\n\nCode to edit:\n\`\`\`${file.language ?? ''}\n${selectedText}\n\`\`\``;
    const fullPrompt = buildCommandPrompt('edit', instruction);

    let full = '';
    const cancel = streamAi(
      token,
      {
        modelId: settings.defaultModelId || AI_MODELS[0].id,
        command: 'edit',
        prompt: fullPrompt,
        context: {
          filePath: file.path,
          language: file.language,
          fileContent: file.content,
          selection: selectedText,
        },
      },
      {
        onToken: (chunk) => {
          full += chunk;
        },
        onDone: (finalText) => {
          setStreaming(false);
          abortRef.current = null;
          const replacement = extractFirstCodeBlock(finalText || full);
          if (!replacement) {
            setError('Model returned no code block');
            return;
          }
          // Swap the selection with the replacement and open the diff on
          // the full file so the user can accept/reject the change.
          const before = file.content.indexOf(selectedText);
          let proposed: string;
          if (before < 0) {
            // Selection not found verbatim (e.g. user had cursor-only);
            // fall back to appending the replacement.
            proposed = replacement;
          } else {
            proposed =
              file.content.slice(0, before) +
              replacement +
              file.content.slice(before + selectedText.length);
          }
          openDiff({
            path: file.path,
            original: file.content,
            proposed,
            label: `inline edit · ${settings.defaultModelId || AI_MODELS[0].id}`,
          });
          onClose();
        },
        onError: (err) => {
          setStreaming(false);
          abortRef.current = null;
          setError(err.message);
        },
      },
    );
    abortRef.current = cancel;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="inline-edit"
      style={{ top, left, width: width ?? 520 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="inline-edit__head">
        <span className="inline-edit__badge">Edit</span>
        <span className="inline-edit__hint">
          {selectedText ? `${selectedText.length} chars selected` : 'no selection — full file'}
        </span>
        <button
          type="button"
          className="inline-edit__close"
          onClick={() => {
            abortRef.current?.();
            onClose();
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <textarea
        ref={inputRef}
        className="inline-edit__input"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask SUXAI to edit the selection… (Enter to send, Shift+Enter newline, Esc to cancel)"
        rows={2}
        disabled={streaming}
      />
      {error && <div className="inline-edit__error">⚠ {error}</div>}
      <div className="inline-edit__foot">
        <span className="inline-edit__model">
          {AI_MODELS.find((m) => m.id === settings.defaultModelId)?.label ?? 'default model'}
        </span>
        {streaming ? (
          <span className="inline-edit__streaming">
            <Spinner size={10} /> editing…
          </span>
        ) : (
          <span className="inline-edit__kbd">Enter ↵</span>
        )}
      </div>
    </div>
  );
}
