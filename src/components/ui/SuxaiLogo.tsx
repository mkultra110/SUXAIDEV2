import type { JSX } from 'react';
import './SuxaiLogo.css';

/**
 * SUXAI brand logotype — v2.0 « Obsidian Warm ».
 *
 * Geometric "S" inscribed in a rounded square. Fill is the amber
 * accent gradient (theme tokens via CSS variables — see SuxaiLogo.css)
 * with a top-edge glint for the « machined glass » feel.
 *
 * Render with `size={n}` to scale uniformly. The `glow` prop adds a
 * soft outer halo — used on the login screen, off in the dense
 * titlebar to avoid bleeding into adjacent chrome.
 *
 * IMPORTANT : we deliberately keep the SVG shape in JSX but push all
 * colour values into CSS custom properties consumed inside the SVG
 * via `currentColor`/inline `style` referring to vars. This lets the
 * mark swap palette automatically when [data-theme] flips.
 */
export function SuxaiLogo({
  size = 24,
  glow = false,
}: {
  size?: number;
  glow?: boolean;
}): JSX.Element {
  return (
    <svg
      className={`suxai-logo${glow ? ' suxai-logo--glow' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-label="SUXAI"
      role="img"
    >
      {/* Rounded-square plate, filled by the amber accent token. */}
      <rect
        className="suxai-logo__plate"
        x="1"
        y="1"
        width="30"
        height="30"
        rx="9"
      />
      {/* Top-edge glint for « machined glass » feel. */}
      <rect
        className="suxai-logo__glint"
        x="1"
        y="1"
        width="30"
        height="14"
        rx="9"
      />
      {/* Geometric S — single stroke. */}
      <path
        className="suxai-logo__mark"
        d="M22.4 9.6c-1.5-1.6-3.7-2.4-6.4-2.4-3.6 0-6 1.7-6 4.5 0 2.5 2 3.7 5.6 4.4l2.2 0.4c2 0.4 3.0 0.9 3.0 2.0 0 1.2-1.2 2.0-3.4 2.0-2.6 0-4.5-1.0-5.6-2.4"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
