import React from 'react';

/**
 * Fermat brand mark.
 *
 * An ink-stamp monogram — rounded rectangle in deep manuscript ink, with a
 * flourished italic "F" in antique gold and the mathematical "∴" (therefore)
 * tucked beneath. The look is intentionally typographic rather than iconic:
 * it reads as a rubricated initial from a theorem manuscript, not a generic
 * SaaS logo. Self-contained SVG.
 */
export default function Logo({ size = 28, className = '', title = 'Fermat' }) {
  const gradId = React.useId();
  const inkId  = React.useId();

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        {/* Whisky-gold vertical wash — old leather, not SaaS purple */}
        <linearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"  stopColor="#e8b787" />
          <stop offset="50%" stopColor="#d4a574" />
          <stop offset="100%" stopColor="#b5854d" />
        </linearGradient>

        {/* Deep manuscript-ink tile with a warm bias (not grey-black) */}
        <linearGradient id={inkId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#2a231d" />
          <stop offset="100%" stopColor="#17130f" />
        </linearGradient>
      </defs>

      {/* Stamp tile */}
      <rect x="1" y="1" width="30" height="30" rx="6.5" ry="6.5"
            fill={`url(#${inkId})`}
            stroke="#3a2f26" strokeWidth="0.8" />

      {/* Subtle inner bevel — top-edge highlight */}
      <rect x="2" y="2" width="28" height="12" rx="5.5" ry="5.5"
            fill="#ffe8c2" opacity="0.04" />

      {/* Italic flourish "F" — drawn as filled paths, not a font,
          so the stamp looks identical in every environment. */}
      <g fill={`url(#${gradId})`}>
        {/*
          A single-stroke F with a trailing serif tail at the bottom —
          drawn with Bézier curves to pick up that characterful slant you
          get from Fraunces at display sizes.
        */}
        <path d="
          M 11.2 6.5
          C 15.5 6.1, 19.8 6.5, 22.4 7.1
          C 22.8 7.2, 22.9 7.7, 22.6 8.1
          L 22.0 9.0
          C 21.7 9.4, 21.2 9.5, 20.8 9.4
          C 19.0 8.9, 16.4 8.7, 13.8 8.9
          L 12.7 14.0
          C 14.3 13.9, 16.0 13.8, 17.5 13.9
          C 17.9 13.9, 18.1 14.3, 17.9 14.7
          L 17.5 15.5
          C 17.3 15.9, 16.9 16.1, 16.5 16.1
          C 15.1 16.1, 13.6 16.2, 12.2 16.4
          L 10.2 24.8
          C 10.1 25.2, 9.7 25.5, 9.3 25.4
          L 7.9 25.2
          C 7.4 25.1, 7.1 24.6, 7.3 24.1
          L 10.5 8.3
          C 10.6 7.8, 10.8 7.1, 11.2 6.5
          Z
        " />
      </g>

      {/* ∴ (therefore) — three dots in gold, lower-right corner */}
      <g fill="#d4a574">
        <circle cx="23.6" cy="20.0" r="0.95" />
        <circle cx="21.8" cy="23.3" r="0.95" />
        <circle cx="25.4" cy="23.3" r="0.95" />
      </g>
    </svg>
  );
}
