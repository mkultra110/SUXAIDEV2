/**
 * v3.0 — Mosa, mascotte SUXAI.
 *
 * « Esprit-luciole-champignon » : créature inventée pour le design
 * system Atelier Dark. Champignon doré aux dot-glow lucioles, base
 * ventre miel, chapeau cuivre. Le SVG complet est inliné (~50 lignes)
 * pour éviter un round-trip vers un asset externe et tirer parti des
 * defs `radialGradient` + `filter` localement scopés à l'instance.
 *
 * Usage :
 *   <MosaMascot size={120} />               // par défaut, 120 px
 *   <MosaMascot size={64} className="..." /> // override props
 *
 * Le SVG hérite du `<defs>` de l'export `claude.ai/design`, on garde
 * les IDs uniques par instance pour permettre plusieurs mascottes
 * sur la même page sans collision.
 */
import { useId } from 'react';

interface Props {
  size?: number;
  className?: string;
  /** Optional alt-like description for assistive tech. */
  title?: string;
}

export function MosaMascot({ size = 120, className, title = 'Mosa' }: Props) {
  // Suffix all internal IDs so multiple <MosaMascot /> can coexist
  // without `<use href>` collisions or filter cross-talk.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const idGlow = `mosa-glow-${uid}`;
  const idBelly = `mosa-belly-${uid}`;
  const idCap = `mosa-cap-${uid}`;
  return (
    <svg
      role="img"
      aria-label={title}
      className={className}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <defs>
        <filter id={idGlow} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id={idBelly} cx="50%" cy="60%" r="55%">
          <stop offset="0%" stopColor="#e8b86a" />
          <stop offset="100%" stopColor="#b8784a" />
        </radialGradient>
        <radialGradient id={idCap} cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#c8835a" />
          <stop offset="100%" stopColor="#85522f" />
        </radialGradient>
      </defs>

      {/* shadow puddle */}
      <ellipse cx="100" cy="178" rx="42" ry="5" fill="#000" opacity="0.18" />
      {/* tiny legs / roots */}
      <path d="M78 168 q-3 6 -1 10" stroke="#5a3820" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M122 168 q3 6 1 10" stroke="#5a3820" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* body — honey belly with bronze stroke */}
      <path
        d="M55 130 Q55 80 100 70 Q145 80 145 130 Q145 168 100 170 Q55 168 55 130 z"
        fill={`url(#${idBelly})`}
        stroke="#5a3820"
        strokeWidth="2"
      />
      {/* face highlight (warm parchment) */}
      <ellipse cx="100" cy="142" rx="28" ry="22" fill="#f0d8a8" opacity="0.95" />
      {/* mushroom cap — copper gradient */}
      <path
        d="M40 95 Q55 38 100 35 Q145 38 160 95 Q150 105 100 105 Q50 105 40 95 z"
        fill={`url(#${idCap})`}
        stroke="#5a3820"
        strokeWidth="2"
      />
      {/* spore dots on the cap */}
      <circle cx="78" cy="65" r="4" fill="#f5ecda" />
      <circle cx="115" cy="58" r="5" fill="#f5ecda" />
      <circle cx="135" cy="78" r="3" fill="#f5ecda" />
      <circle cx="62" cy="82" r="2.5" fill="#f5ecda" />
      {/* firefly companion (honey glow) */}
      <circle cx="170" cy="92" r="4" fill="#d4a247" filter={`url(#${idGlow})`} opacity="0.9" />
      <line x1="160" y1="92" x2="166" y2="92" stroke="#5a3820" strokeWidth="1.2" />
    </svg>
  );
}
