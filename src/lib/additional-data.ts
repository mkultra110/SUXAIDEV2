import type { EditorContext } from '../contexts/WorkspaceContext';

/**
 * Build the <additional_data> XML block injected into every agent-mode
 * user message. Resolves demonstrative pronouns ("ce script", "cette
 * fonction", "la sélection", "this file", "the function above") so the
 * model never has to ask "which file?" before acting.
 *
 * Cursor's leaked system prompts confirm this is the structure they
 * use too. Keys we surface (only those that are present — the model
 * sees a clean payload, no empty placeholders):
 *
 *   <current_file>      : path, language, cursor line/col
 *   <selection>         : line range + selected text (≤4KB)
 *   <visible_range>     : viewport line range
 *   <open_tabs>         : list of open file paths + dirty flag
 *   <recent_edits>      : last 5 edits, newest first
 *   <recently_viewed>   : last 10 distinct files focused
 *   <linter_errors>     : Monaco markers (error/warning) on active file
 *   <workspace>         : workspace root path
 *
 * Trailing newline ensures the user_query that follows starts on a
 * fresh line in the rendered prompt.
 *
 * Skip emission entirely when there's nothing meaningful (no active
 * file AND no recent state) — avoids polluting cache breakpoints
 * with empty XML.
 */
export interface BuildAdditionalDataInput {
  editorContext: EditorContext;
  activeFileLanguage?: string;
  workspaceRoot: string | null;
  /** True when the user already attached the active file via @-mention
   *  or paperclip — we still emit the metadata block but skip the hint
   *  "Use read_file on this path" to avoid double instruction. */
  userAlreadyAttached: boolean;
}

const ESCAPE_TABLE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_TABLE[c]);
}

function shortPath(p: string, root: string | null): string {
  if (!root) return p;
  if (p === root) return '.';
  if (p.startsWith(root + '/') || p.startsWith(root + '\\')) {
    return p.slice(root.length + 1);
  }
  return p;
}

export function buildAdditionalDataXml(input: BuildAdditionalDataInput): string {
  const { editorContext: ctx, activeFileLanguage, workspaceRoot, userAlreadyAttached } = input;
  const lines: string[] = [];
  const hasAnyState =
    !!ctx.activeFilePath ||
    ctx.recentEdits.length > 0 ||
    ctx.recentlyViewedFiles.length > 0 ||
    ctx.diagnostics.length > 0;
  if (!hasAnyState) return '';

  lines.push('\n\n<additional_data>');

  if (workspaceRoot) {
    lines.push(`  <workspace path="${xmlEscape(workspaceRoot)}" />`);
  }

  if (ctx.activeFilePath) {
    const langAttr = activeFileLanguage ? ` lang="${xmlEscape(activeFileLanguage)}"` : '';
    const cursorAttr = ctx.cursorPosition
      ? ` cursor_line="${ctx.cursorPosition.line}" cursor_col="${ctx.cursorPosition.column}"`
      : '';
    lines.push(
      `  <current_file path="${xmlEscape(ctx.activeFilePath)}"${langAttr}${cursorAttr} />`,
    );
    if (!userAlreadyAttached) {
      lines.push(
        `  <!-- The user is currently focused on this file. When they say "ce script", "this file", "ce fichier" → resolve to current_file.path. Use read_file on this path before editing if you don't already have its contents. -->`,
      );
    }
  }

  if (ctx.selection) {
    const { startLine, endLine, text } = ctx.selection;
    const display = xmlEscape(text);
    lines.push(
      `  <selection start_line="${startLine}" end_line="${endLine}">`,
    );
    lines.push(display);
    lines.push('  </selection>');
    lines.push(
      `  <!-- When the user says "la sélection", "this selection", "ce code" → resolve to <selection>. -->`,
    );
  }

  if (ctx.visibleRange) {
    lines.push(
      `  <visible_range start_line="${ctx.visibleRange.startLine}" end_line="${ctx.visibleRange.endLine}" />`,
    );
  }

  if (ctx.recentEdits.length > 0) {
    lines.push('  <recent_edits>');
    for (const e of ctx.recentEdits) {
      const ago = Math.max(1, Math.round((Date.now() - e.ts) / 1000));
      lines.push(
        `    <edit path="${xmlEscape(shortPath(e.path, workspaceRoot))}" line="${e.line}" seconds_ago="${ago}" />`,
      );
    }
    lines.push('  </recent_edits>');
  }

  if (ctx.recentlyViewedFiles.length > 0) {
    lines.push('  <recently_viewed_files>');
    for (const p of ctx.recentlyViewedFiles) {
      lines.push(`    <file path="${xmlEscape(shortPath(p, workspaceRoot))}" />`);
    }
    lines.push('  </recently_viewed_files>');
  }

  if (ctx.diagnostics.length > 0) {
    lines.push('  <linter_errors>');
    for (const d of ctx.diagnostics) {
      lines.push(
        `    <diagnostic severity="${d.severity}" path="${xmlEscape(shortPath(d.path, workspaceRoot))}" line="${d.line}" col="${d.column}">${xmlEscape(d.message)}</diagnostic>`,
      );
    }
    lines.push('  </linter_errors>');
  }

  lines.push('</additional_data>');
  return lines.join('\n');
}
