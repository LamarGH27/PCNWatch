/**
 * The hero illustration: a notice being read, over a city that is being watched.
 *
 * Drawn as inline SVG rather than shipped as an image, for three reasons that
 * all matter more than the convenience of a PNG. It inherits the theme tokens,
 * so it can never be the one element still on the old palette. It stays sharp
 * on every display without a 2x and 3x variant. And it adds no request and no
 * layout shift — the alternative was roughly 200KB of raster that the hero
 * would have waited on.
 *
 * What it shows is the product, not a metaphor: a penalty charge notice with
 * its fields being picked out, a stylised London with enforcement activity on
 * it, and two small readouts of the kind the app actually produces. No robots,
 * no brains, no cyberpunk.
 *
 * `aria-hidden`, and every string in it is decorative. The headline beside it
 * carries the meaning; a screen reader gains nothing from "PCN" rendered as
 * paths and would have to sit through the whole thing.
 */
export function HeroGraphic() {
  return (
    <svg
      viewBox="0 0 520 460"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="hg-sky" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0d1730" />
          <stop offset="100%" stopColor="#0a0e18" />
        </linearGradient>
        <linearGradient id="hg-phone" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="#182236" />
          <stop offset="100%" stopColor="#0d1421" />
        </linearGradient>
        <linearGradient id="hg-scan" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-cyan-400)" stopOpacity="0" />
          <stop offset="50%" stopColor="var(--color-cyan-400)" stopOpacity="0.75" />
          <stop offset="100%" stopColor="var(--color-cyan-400)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="hg-hot" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-activity-4)" stopOpacity="0.85" />
          <stop offset="100%" stopColor="var(--color-activity-4)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hg-hot-cool" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* The city plate: a map, abstracted to the point where it is a texture. */}
      <g>
        <rect x="118" y="36" width="392" height="300" rx="22" fill="url(#hg-sky)" />
        <rect
          x="118"
          y="36"
          width="392"
          height="300"
          rx="22"
          fill="none"
          stroke="rgb(255 255 255 / 0.09)"
        />

        {/* Roads. Two directions, uneven spacing, so it reads as a city rather
            than as graph paper. */}
        <g stroke="rgb(120 160 235 / 0.16)" strokeWidth="1">
          {[70, 108, 152, 205, 246, 290].map((y) => (
            <line key={y} x1="130" y1={y} x2="498" y2={y} />
          ))}
          {[168, 214, 268, 316, 372, 430, 476].map((x) => (
            <line key={x} x1={x} y1="48" x2={x} y2="324" />
          ))}
        </g>

        {/* A river, because it is the one line that makes London read as London. */}
        <path
          d="M130 236 C 196 210, 236 268, 300 250 S 404 208, 498 238"
          fill="none"
          stroke="rgb(47 123 255 / 0.35)"
          strokeWidth="7"
          strokeLinecap="round"
        />

        {/* Enforcement activity. Warm only where it is highest — the amber is
            the one place in the design where a colour means "a lot". */}
        <circle cx="268" cy="152" r="46" fill="url(#hg-hot)" />
        <circle cx="430" cy="108" r="34" fill="url(#hg-hot-cool)" />
        <circle cx="205" cy="268" r="30" fill="url(#hg-hot-cool)" />

        {[
          [268, 152, 'var(--color-activity-4)'],
          [430, 108, 'var(--color-brand-400)'],
          [205, 268, 'var(--color-brand-400)'],
          [372, 205, 'var(--color-cyan-400)'],
        ].map(([cx, cy, fill]) => (
          <circle key={`${cx}-${cy}`} cx={cx as number} cy={cy as number} r="4" fill={fill as string} />
        ))}

        {/* A borough, picked out. Camden is the one with data behind it. */}
        <path
          d="M236 118 L300 104 L328 140 L306 186 L250 180 Z"
          fill="rgb(47 123 255 / 0.18)"
          stroke="var(--color-brand-400)"
          strokeWidth="1.4"
        />
      </g>

      {/* A readout of the kind the product actually shows. */}
      <g transform="translate(352 60)">
        <rect width="160" height="56" rx="13" fill="rgb(10 14 24 / 0.92)" stroke="rgb(255 255 255 / 0.12)" />
        <text x="14" y="23" fill="var(--color-ink-400)" fontSize="9" letterSpacing="0.9">
          ENFORCEMENT ACTIVITY
        </text>
        <text x="14" y="43" fill="var(--color-ink-50)" fontSize="15" fontWeight="650">
          Camden
        </text>
        {[0, 1, 2, 3, 4].map((i) => (
          <rect
            key={i}
            x={104 + i * 9}
            y={44 - (i * 4 + 8)}
            width="5.5"
            height={i * 4 + 8}
            rx="2"
            fill={i > 2 ? 'var(--color-activity-4)' : 'var(--color-brand-500)'}
            opacity={0.55 + i * 0.11}
          />
        ))}
      </g>

      {/* The notice, being read. Foreground, because it is the actual product. */}
      <g transform="translate(30 96)">
        <rect x="0" y="0" width="212" height="330" rx="30" fill="url(#hg-phone)" stroke="rgb(255 255 255 / 0.14)" />
        <rect x="10" y="10" width="192" height="310" rx="22" fill="#070b14" />

        {/* The notice itself. */}
        <g transform="translate(26 34)">
          <rect width="160" height="216" rx="8" fill="#f3f5f9" />
          <text x="14" y="26" fill="#0a0e18" fontSize="9" fontWeight="700" letterSpacing="0.7">
            PENALTY CHARGE NOTICE
          </text>
          <line x1="14" y1="34" x2="146" y2="34" stroke="#c9d1de" />
          {[
            ['PCN number', 'WM7734••••'],
            ['Contravention', '12'],
            ['Date', '04 Jan 2026'],
            ['Location', 'Gloucester Place'],
          ].map(([label, value], i) => (
            <g key={label} transform={`translate(14 ${52 + i * 30})`}>
              <text fill="#6b7787" fontSize="7">
                {label}
              </text>
              <text y="13" fill="#0a0e18" fontSize="10" fontWeight="600">
                {value}
              </text>
            </g>
          ))}
          {/* Field-recognition brackets: the extraction, made visible. */}
          {[46, 76, 106, 136].map((y) => (
            <rect
              key={y}
              x="9"
              y={y}
              width="142"
              height="24"
              rx="4"
              fill="none"
              stroke="var(--color-cyan-500)"
              strokeOpacity="0.55"
              strokeDasharray="3 3"
            />
          ))}
        </g>

        {/*
          The scan line.

          Animated in CSS rather than with SMIL, and the difference is not
          stylistic: `prefers-reduced-motion` cannot stop an `animateTransform`,
          so a SMIL sweep would have run forever for somebody who had asked
          their system for no motion. The global reduced-motion block already
          neutralises CSS animation, so this stops with everything else.
        */}
        <rect className="fr-scanline" x="26" y="34" width="160" height="3" fill="url(#hg-scan)" />

        {/* Two corner marks, the universal grammar for "this is being read". */}
        <g stroke="var(--color-cyan-400)" strokeWidth="2.2" fill="none" strokeLinecap="round">
          <path d="M22 44 v-12 h12" />
          <path d="M190 44 v-12 h-12" />
          <path d="M22 240 v12 h12" />
          <path d="M190 240 v12 h-12" />
        </g>

        {/* What the app says next. */}
        <g transform="translate(26 268)">
          <rect width="160" height="34" rx="9" fill="rgb(23 188 212 / 0.13)" stroke="rgb(23 188 212 / 0.35)" />
          <circle cx="19" cy="17" r="6" fill="none" stroke="var(--color-cyan-400)" strokeWidth="1.6" />
          <path d="M16.2 17.2 l2.2 2.2 l4.4 -4.8" fill="none" stroke="var(--color-cyan-400)" strokeWidth="1.6" strokeLinecap="round" />
          <text x="34" y="15" fill="var(--color-cyan-300)" fontSize="8.5" letterSpacing="0.5">
            DETAILS READ
          </text>
          <text x="34" y="26" fill="var(--color-ink-300)" fontSize="8.5">
            Check before we use them
          </text>
        </g>
      </g>

      {/* A floating chip, tying the two halves together. */}
      <g transform="translate(240 352)">
        <rect width="196" height="46" rx="13" fill="rgb(10 14 24 / 0.94)" stroke="rgb(47 123 255 / 0.34)" />
        <circle cx="26" cy="23" r="9" fill="rgb(47 123 255 / 0.18)" stroke="var(--color-brand-400)" strokeWidth="1.2" />
        <path d="M22 23 l3 3 l6 -7" fill="none" stroke="var(--color-brand-300)" strokeWidth="1.6" strokeLinecap="round" />
        <text x="44" y="20" fill="var(--color-ink-200)" fontSize="10" fontWeight="600">
          Contravention 12 explained
        </text>
        <text x="44" y="33" fill="var(--color-ink-400)" fontSize="9">
          in plain English
        </text>
      </g>
    </svg>
  );
}
