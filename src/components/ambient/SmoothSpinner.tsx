/**
 * SmoothSpinner — Bulletproof, Hardware-Accelerated SVG SMIL & CSS Spinner.
 *
 * Designed to eliminate static/frozen loader issues:
 *  - Native SVG SMIL `<animateTransform>` rotates 360° around `(12, 12)` independently of external CSS.
 *  - Immune to `prefers-reduced-motion: reduce` or Lite Mode animation kill-switches.
 *  - Perfectly centered with crisp 2.75px vector stroke and subtle 22% opacity track.
 */

export function SmoothSpinner({
  size = 14,
  className = "text-white",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`amb-spinner inline-block align-middle shrink-0 ${className}`}
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2.75"
      />
      <path
        d="M 12 3 A 9 9 0 0 1 21 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.75s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

export default SmoothSpinner;
