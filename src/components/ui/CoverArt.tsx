/**
 * CoverArt — the one shared cover surface for every card that shows a course/subject/
 * material thumbnail (Courses grid, Continue-Learning, etc.). It resolves a layered
 * fallback so a card is NEVER empty or broken:
 *
 *   Tier 1 — the extracted image thumbnail (video frame), when `thumbnailPath` is set.
 *   Tier 2 — a deterministic CSS gradient "blob" generated from a stable seed (id/name),
 *            so the same item always renders the same cover (no flicker across reloads)
 *            and different items look distinct. A centered glyph/emoji sits on top.
 *
 * The gradient stays inside the brand palette (lime / cyan / orange) by hashing the seed
 * to one of a few curated duotone pairs, then placing two soft radial blobs — pure CSS,
 * zero network cost, no layout shift. Images fade in once loaded (reduced-motion safe via
 * a plain CSS transition). On image error we fall back to the gradient automatically.
 */

import { useMemo, useState } from "react";
import { assetUrl } from "../../lib/ipc";
import { cn } from "../../lib/utils";

interface CoverArtProps {
  /** Absolute thumbnail path from the backend (null → gradient fallback). */
  thumbnailPath?: string | null;
  /** Stable seed for the deterministic gradient (e.g. subject id or name). */
  seed: string | number;
  /** Centered glyph shown on the gradient fallback (emoji or short text). */
  glyph?: string;
  /** Extra classes for the wrapper (aspect ratio is set by the caller). */
  className?: string;
  /** Alt text for the image tier (decorative by default). */
  alt?: string;
}

/** Curated brand-palette duotone pairs for the gradient fallback. */
const PALETTES: { from: string; to: string; blob: string }[] = [
  { from: "#AAFF00", to: "#0C0C0C", blob: "rgba(170,255,0,0.28)" }, // lime
  { from: "#22D3EE", to: "#0C0C0C", blob: "rgba(34,211,238,0.28)" }, // cyan
  { from: "#FF6B35", to: "#0C0C0C", blob: "rgba(255,107,53,0.26)" }, // orange
  { from: "#22D3EE", to: "#AAFF00", blob: "rgba(120,230,120,0.24)" }, // cyan→lime
  { from: "#FF6B35", to: "#AAFF00", blob: "rgba(210,190,40,0.24)" }, // orange→lime
];

/** Stable string hash (FNV-1a-ish) → non-negative int. */
function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export default function CoverArt({ thumbnailPath, seed, glyph, className, alt = "" }: CoverArtProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  const src = thumbnailPath && !imgFailed ? assetUrl(thumbnailPath) : "";

  // Deterministic gradient derived from the seed.
  const gradient = useMemo(() => {
    const h = hashSeed(seed);
    const pal = PALETTES[h % PALETTES.length];
    const angle = 120 + (h % 120); // 120–240deg, stable per seed
    const bx = 20 + (h % 40); // blob x 20–60%
    const by = 25 + ((h >> 3) % 40); // blob y 25–65%
    return {
      backgroundImage:
        `radial-gradient(circle at ${bx}% ${by}%, ${pal.blob}, transparent 60%),` +
        `linear-gradient(${angle}deg, ${pal.from}22 0%, ${pal.to} 78%)`,
    } as const;
  }, [seed]);

  return (
    <div className={cn("relative overflow-hidden bg-ink-700", className)}>
      {/* Gradient tier — always painted underneath, so there's never a blank flash. */}
      <div className="absolute inset-0" style={gradient} aria-hidden>
        {glyph && (
          <div className="flex h-full w-full items-center justify-center">
            <span className="text-4xl opacity-60 drop-shadow-[0_2px_8px_rgba(0,0,0,0.4)]" aria-hidden>
              {glyph}
            </span>
          </div>
        )}
      </div>

      {/* Image tier — fades in over the gradient once decoded. */}
      {src && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgFailed(true)}
          className={cn(
            "relative h-full w-full object-cover transition-opacity duration-500 ease-smooth",
            imgLoaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </div>
  );
}
