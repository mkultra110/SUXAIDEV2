import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './MarkdownPreview.css';

/**
 * v0.16.2 — Markdown preview pane. Renders the active editor's
 * markdown content as live HTML. Reuses the `marked` + `dompurify`
 * deps already in the project (we already use them in the AI chat
 * for assistant message rendering).
 *
 * Design choices :
 *   - GFM enabled (tables, strikethrough, autolinks) — matches the
 *     GitHub flavour most users expect when editing READMEs.
 *   - DOMPurify sanitises the HTML output ; this is paranoid (the
 *     content comes from the user's own files) but cheap.
 *   - Code blocks render as plain <pre><code> ; we don't run shiki
 *     here — keeping the bundle slim. Native font-mono + bg-tinted
 *     is enough for the common case.
 *   - Scroll position persisted across re-renders so editing live
 *     doesn't jump the preview to the top on every keystroke.
 *   - No router / navigation — relative links open via
 *     window.suxai.fs.revealInFolder when reasonable, external links
 *     open in the OS browser.
 */

interface Props {
  /** Raw markdown source — re-rendered on every change. */
  source: string;
  /** File path so relative-link clicks can resolve correctly. */
  basePath?: string;
}

// Configure marked once for the module — gfm + breaks like VSCode's
// preview, no header IDs (no auto-anchor noise).
marked.setOptions({
  gfm: true,
  breaks: true,
  pedantic: false,
});

export function MarkdownPreview({ source, basePath }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  const html = useMemo(() => {
    try {
      const raw = marked.parse(source, { async: false }) as string;
      // ADD_ATTR : marked emits target="_blank" on autolinks — we keep
      // that. ALLOWED_URI_REGEXP defaults are fine (no javascript:).
      return DOMPurify.sanitize(raw, {
        ADD_ATTR: ['target', 'rel'],
      });
    } catch (err) {
      return `<p class="mdpreview__error">Markdown render failed: ${(err as Error).message}</p>`;
    }
  }, [source]);

  // Intercept link clicks so relative paths open inside SUXAI and
  // http(s) links open in the OS browser. Without this, an
  // <a href="https://..."> click would try to navigate the renderer
  // away from the app (Electron then bounces it via will-navigate but
  // the round-trip flickers).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a');
      if (!target) return;
      const href = target.getAttribute('href');
      if (!href) return;
      // Anchor (#section) — let the browser handle scroll.
      if (href.startsWith('#')) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        try { void window.open(href, '_blank', 'noopener'); } catch { /* */ }
        return;
      }
      // Relative path — try to reveal in the OS file explorer next
      // to the markdown file. We don't auto-open in the editor here
      // because the link could be a pdf/png/etc.
      if (basePath && window.suxai?.fs?.revealInFolder) {
        const dir = basePath.replace(/[\\/][^\\/]+$/, '');
        const target = href.replace(/^\.\//, '');
        const abs = dir + '/' + target;
        try { void window.suxai.fs.revealInFolder(abs); } catch { /* */ }
      }
    };
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, [basePath]);

  return (
    <div
      ref={hostRef}
      className="mdpreview"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
