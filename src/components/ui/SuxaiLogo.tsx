import { useId, type JSX } from 'react';
import './SuxaiLogo.css';

/**
 * SUXAI brand logotype — v3.0 « Atelier Dark ».
 *
 * Geometric "S" inscribed in a rounded square. v3 ajoute un vrai
 * `<linearGradient>` SVG qui glisse de bronze cuivre vers honey miel
 * sur la plate (au lieu d'un fill solide), pour donner au mark la
 * profondeur d'un objet en métal patiné — le glint top-edge complète
 * le rendu « machined glass ». Les IDs sont suffixés via `useId()`
 * pour autoriser plusieurs instances dans le même DOM sans collision.
 *
 * Render avec `size={n}` pour scaler. La prop `glow` ajoute un halo
 * outer — utile sur le LoginScreen, off dans la TitleBar dense pour
 * éviter le bleeding sur le chrome adjacent.
 */
export function SuxaiLogo({
  size = 24,
  glow = false,
}: {
  size?: number;
  glow?: boolean;
}): JSX.Element {
  // Suffix gradient + glint IDs so multiple SuxaiLogo instances on the
  // same page (titlebar + welcome + login) don't collide.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradPlate = `suxai-logo-plate-${uid}`;
  const gradGlint = `suxai-logo-glint-${uid}`;
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
      <defs>
        {/*
          Plate gradient — diagonal top-left → bottom-right, bronze to
          honey. The two stops read CSS variables so the mark reskins
          when [data-theme] flips. fall-back to currentColor on engines
          that don't honour `var()` inside <stop> (rare but seen on
          older WebKit).
        */}
        <linearGradient id={gradPlate} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="var(--suxai-logo-grad-top, var(--bronze-400, currentColor))" />
          <stop offset="55%"  stopColor="var(--suxai-logo-grad-mid, var(--bronze-500, currentColor))" />
          <stop offset="100%" stopColor="var(--suxai-logo-grad-bot, var(--bronze-700, currentColor))" />
        </linearGradient>
        {/*
          Glint gradient — ivory highlight along the top edge,
          fading downward. Approximates an Apple-style hard light
          source on a brushed-metal plate.
        */}
        <linearGradient id={gradGlint} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="var(--suxai-logo-glint-top, rgba(255,255,255,0.32))" />
          <stop offset="100%" stopColor="var(--suxai-logo-glint-bot, rgba(255,255,255,0))" />
        </linearGradient>
      </defs>
      {/* Rounded-square plate, filled by the gradient. */}
      <rect
        className="suxai-logo__plate"
        x="1"
        y="1"
        width="30"
        height="30"
        rx="9"
        fill={`url(#${gradPlate})`}
      />
      {/* Top-edge glint — fades from ivory to transparent. */}
      <rect
        className="suxai-logo__glint"
        x="1"
        y="1"
        width="30"
        height="14"
        rx="9"
        fill={`url(#${gradGlint})`}
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
