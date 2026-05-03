/**
 * v3.2 — Atelier icon system.
 *
 * Le bundle Claude Design livre un sprite SVG de 61 icônes custom
 * dessinées spécifiquement pour SUXAI (chevrons, fichiers, git,
 * AI, état, préférences…). Chaque symbole est en stroke
 * `currentColor`, viewBox 24×24, stroke-width 1.5 — donc
 * `<AtelierIcon />` suit la couleur du parent et scale uniformément
 * via la prop `size`.
 *
 * Architecture :
 *   - `<AtelierIconSprite />` : monte une seule fois le sprite
 *     complet en `<svg style={display:none}>` au root de l'app.
 *     Importé via Vite `?raw` pour inliner les 16 KB de SVG sans
 *     fetch externe et préserver l'offline-first Electron.
 *   - `<AtelierIcon name="..." size={n} />` : rend
 *     `<svg><use href="#i-name" /></svg>` dans n'importe quel
 *     composant. Le navigateur cherche le `<symbol id="i-name">`
 *     dans le DOM (mounté par le sprite) et le matérialise.
 */
import sprite from '../../assets/atelier-icons.svg?raw';

export type AtelierIconName =
  | 'i-chevron-right' | 'i-chevron-left' | 'i-chevron-down' | 'i-chevron-up'
  | 'i-arrow-up-right' | 'i-arrow-right'
  | 'i-close' | 'i-menu' | 'i-ellipsis' | 'i-plus' | 'i-pin' | 'i-check'
  | 'i-search'
  | 'i-file' | 'i-file-code' | 'i-file-md'
  | 'i-folder' | 'i-folder-open'
  | 'i-git-branch' | 'i-git-commit' | 'i-git-merge' | 'i-git-pr'
  | 'i-diff' | 'i-conflict' | 'i-stash'
  | 'i-terminal' | 'i-play' | 'i-stop' | 'i-build'
  | 'i-sparkle' | 'i-brain' | 'i-suggestion' | 'i-spark-small'
  | 'i-accept' | 'i-reject'
  | 'i-warning' | 'i-info' | 'i-loading' | 'i-sync' | 'i-hourglass'
  | 'i-gear' | 'i-person' | 'i-bell'
  | 'i-theme' | 'i-keyboard' | 'i-plugin' | 'i-update'
  | 'i-sidebar' | 'i-panel-bottom'
  | 'i-cursor' | 'i-bookmark' | 'i-comment' | 'i-fold' | 'i-replace'
  | 'i-package' | 'i-log'
  | 'i-dot' | 'i-lock' | 'i-eye' | 'i-mail'
  | 'i-coffee' | 'i-leaf';

interface IconProps {
  name: AtelierIconName;
  size?: number;
  className?: string;
  /** Optional accessible label. Default: aria-hidden. */
  label?: string;
}

export function AtelierIcon({ name, size = 16, className, label }: IconProps) {
  const ariaProps = label
    ? { role: 'img' as const, 'aria-label': label }
    : { 'aria-hidden': true };
  return (
    <svg
      width={size}
      height={size}
      className={className}
      {...ariaProps}
    >
      <use href={`#${name}`} />
    </svg>
  );
}

/** Mount once at App root. Renders the entire sprite in a hidden
 *  `<svg style="display:none">` so any `<use href="#i-name" />`
 *  elsewhere in the tree resolves. */
export function AtelierIconSprite() {
  return (
    <div
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: sprite }}
    />
  );
}
