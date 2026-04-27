import type { JSX } from 'react';

/**
 * SUXAI brand logotype — v1.0.1.
 *
 * Geometric "S" inscribed inside a rounded square, dual-gradient fill
 * (indigo→violet) with a subtle inner highlight. Designed to read at
 * 14 px (titlebar) up to 96 px (login hero) without losing detail.
 *
 * Render with `size={n}` to scale uniformly. The `glow` prop adds a
 * soft outer halo — used on the login screen, off in the dense
 * titlebar to avoid bleeding into adjacent chrome.
 */
export function SuxaiLogo({
  size = 24,
  glow = false,
}: {
  size?: number;
  glow?: boolean;
}): JSX.Element {
  const id = `suxai-logo-${size}-${glow ? 'g' : 'n'}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-label="SUXAI"
      role="img"
      style={glow ? { filter: 'drop-shadow(0 0 12px rgba(125, 130, 248, 0.55))' } : undefined}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="6" y1="2" x2="26" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8b8efc" />
          <stop offset="0.5" stopColor="#6366f1" />
          <stop offset="1" stopColor="#4548c0" />
        </linearGradient>
        <linearGradient id={`${id}-mark`} x1="9" y1="6" x2="23" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.96" />
          <stop offset="1" stopColor="#dadcff" stopOpacity="0.86" />
        </linearGradient>
        <linearGradient id={`${id}-glint`} x1="6" y1="2" x2="6" y2="14" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Rounded-square plate */}
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="9"
        fill={`url(#${id}-bg)`}
        stroke="rgba(255, 255, 255, 0.14)"
        strokeWidth="1"
      />
      {/* Top-edge glint for "machined glass" feel */}
      <rect x="1" y="1" width="30" height="14" rx="9" fill={`url(#${id}-glint)`} />

      {/* Geometric S — two arcs forming the SUXAI mark */}
      <path
        d="M22.4 9.6c-1.5-1.6-3.7-2.4-6.4-2.4-3.6 0-6 1.7-6 4.5 0 2.5 2 3.7 5.6 4.4l2.2 0.4c2 0.4 3.0 0.9 3.0 2.0 0 1.2-1.2 2.0-3.4 2.0-2.6 0-4.5-1.0-5.6-2.4"
        stroke={`url(#${id}-mark)`}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
