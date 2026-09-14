/**
 * YouTubeSkeletonList — Premium YouTube Dark Mode Skeleton Loading UI.
 *
 * Implements Google YouTube's signature shimmer-wave skeleton:
 *  - High-precision placeholder geometry matching exact YouTube stream result cards.
 *  - GPU-accelerated light-sweep wave highlight (.amb-shimmer).
 *  - GSAP staggered entrance animation for silky 60fps presentation.
 *  - Instant responsive feedback when searching or switching vibes.
 */

import { useRef, useEffect } from "react";
import gsap from "gsap";
import { SmoothSpinner } from "./SmoothSpinner";

function YouTubeSkeletonCard() {
  return (
    <div className="amb-skeleton-card amb-shimmer p-2.5 rounded-[18px] border border-white/[0.04] bg-white/[0.015] flex items-center gap-3 select-none">
      {/* Thumbnail placeholder */}
      <div className="w-16 h-11 rounded-[10px] bg-white/[0.06] relative flex-shrink-0 border border-white/[0.04] overflow-hidden">
        <div className="absolute bottom-1 right-1 w-6 h-2 rounded-sm bg-white/[0.1]" />
      </div>

      {/* Info title & channel lines */}
      <div className="flex-1 min-w-0 pr-1 space-y-1.5">
        <div className="h-3 rounded-full bg-white/[0.08] w-[84%]" />
        <div className="h-2.5 rounded-full bg-white/[0.04] w-[52%]" />
        <div className="flex items-center gap-2 pt-0.5">
          <div className="h-2 rounded-full bg-white/[0.04] w-[32%]" />
          <div className="h-2 rounded-full bg-white/[0.03] w-12" />
        </div>
      </div>

      {/* Action button pills */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <div className="w-7 h-7 rounded-full bg-white/[0.03] border border-white/[0.03]" />
        <div className="w-7 h-7 rounded-full bg-white/[0.03] border border-white/[0.03]" />
        <div className="w-7 h-7 rounded-full bg-white/[0.03] border border-white/[0.03]" />
      </div>
    </div>
  );
}

export function YouTubeSkeletonList({ query }: { query?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const cards = containerRef.current.querySelectorAll(".amb-skeleton-card");
    gsap.fromTo(
      cards,
      { opacity: 0, y: 7 },
      { opacity: 1, y: 0, duration: 0.26, stagger: 0.04, ease: "power2.out", overwrite: "auto" }
    );
  }, []);

  return (
    <div ref={containerRef} className="space-y-2 pt-1" aria-busy="true" aria-live="polite">
      {/* Informative stream search status header */}
      <div className="flex items-center justify-between px-1.5 pb-0.5 text-[11px] text-white/50">
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <SmoothSpinner size={12} className="text-blue-400" />
          <span className="truncate">
            Searching YouTube 160k Opus streams{query ? ` for "${query}"` : ""}…
          </span>
        </div>
        <span className="text-[9px] font-mono text-blue-300/60 uppercase tracking-wider flex-shrink-0">
          Hi-Fi Studio
        </span>
      </div>

      {/* 5 YouTube Skeleton Cards */}
      {[0, 1, 2, 3, 4].map((i) => (
        <YouTubeSkeletonCard key={i} />
      ))}
    </div>
  );
}

export default YouTubeSkeletonList;
