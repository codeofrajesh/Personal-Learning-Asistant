/**
 * ProgressRing — a circular progress indicator (SVG arc).
 *
 * Used by the Courses "Continue Learning" card and the Course detail header. The lime
 * arc draws on mount via a CSS stroke-dashoffset transition (instant under
 * prefers-reduced-motion); the percentage sits in the centre.
 *
 * Design DNA: lime arc on a faint track, rounded line-cap, a soft lime drop-shadow.
 * Presentational only — no GSAP inside, so it composes cleanly into GSAP-animated pages.
 */

import { useEffect, useRef, useState } from "react";

interface ProgressRingProps {
  /** 0-100. */
  pct: number;
  /** Outer diameter in px. */
  size?: number;
  /** Arc stroke width in px. */
  strokeWidth?: number;
  /** Optional caption under the percentage (e.g. "complete"). */
  label?: string;
  /** Accessible label describing what the progress represents (rendered sr-only). */
  ariaLabel?: string;
}

export default function ProgressRing({
  pct,
  size = 120,
  strokeWidth = 10,
  label,
  ariaLabel,
}: ProgressRingProps) {
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const targetOffset = circumference * (1 - clamped / 100);

  const arcRef = useRef<SVGCircleElement>(null);
  const [mounted, setMounted] = useState(false);

  // Draw on mount: keep the arc hidden until the first frame, then flip to the target
  // offset so the CSS transition runs. Reduced-motion → show the final state instantly.
  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setMounted(true);
      return;
    }
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={strokeWidth}
        />
        <circle
          ref={arcRef}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#AAFF00"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={mounted ? targetOffset : circumference}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            transition: "stroke-dashoffset 1.1s cubic-bezier(0.16, 1, 0.3, 1)",
            filter: "drop-shadow(0 0 6px rgba(170,255,0,0.32))",
          }}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold leading-none text-content-primary">
          {clamped}%
        </span>
        {label && (
          <span className="mt-1 text-[10px] uppercase tracking-wide text-content-muted">
            {label}
          </span>
        )}
      </div>
      {ariaLabel && <span className="sr-only">{ariaLabel}: {clamped}%</span>}
    </div>
  );
}
