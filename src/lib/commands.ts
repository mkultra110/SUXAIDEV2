import type { AiCommand } from '../api/quatarly';

/**
 * Tiny event bus for cross-component AI commands. The EditorPanel emits
 * these when the user picks a code action from the floating toolbar; the
 * AIPanel subscribes and kicks off the corresponding streaming request.
 *
 * Using a CustomEvent instead of context + callbacks keeps both sides
 * independent and avoids prop drilling through the whole layout.
 */

export interface AiCommandEventDetail {
  command: Exclude<AiCommand, 'chat'>;
  selection?: string;
}

const EVENT = 'suxai:ai-command';

export function emitAiCommand(detail: AiCommandEventDetail): void {
  window.dispatchEvent(new CustomEvent<AiCommandEventDetail>(EVENT, { detail }));
}

export function onAiCommand(
  handler: (detail: AiCommandEventDetail) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<AiCommandEventDetail>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
