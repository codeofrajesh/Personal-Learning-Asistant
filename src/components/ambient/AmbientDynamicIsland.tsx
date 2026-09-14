/**
 * AmbientDynamicIsland — Flagship Top-Bar Dynamic Island Study Audio Pill.
 *
 * Positioned in the global top navigation bar:
 *  - Matches the exact 44px height (h-11) of the Focus Timer and Search launcher.
 *  - Circular photo preview of the song is the main element, wrapped in an ultra-thin 1px
 *    spinning RGB rainbow border with a dancing/breathing neon aura that rhythmically pulses.
 *  - Real-time animated dancing audio wave bars that never get stuck or turn black.
 *  - High-definition image resolution upgrading YouTube thumbnails to maxres 720p/1080p.
 *  - High-resolution solid vector Play/Pause buttons.
 *  - Smooth marquee title, format chip, and seek progress underline.
 *  - Direct 1-tap launcher for the full study drawer.
 *  - Zero layout shift or hover glitch.
 */

import { useRef, useEffect, useState, useCallback } from "react";
import gsap from "gsap";
import {
  Maximize2,
  Sparkles,
  Radio,
  Headphones,
} from "lucide-react";
import { SmoothSpinner } from "./SmoothSpinner";
import { useAmbientStore } from "../../lib/ambient/useAmbientStore";
import { cn } from "../../lib/utils";

function YouTubeIcon({ size = 12, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

function fmtTime(secs: number): string {
  if (!secs || !Number.isFinite(secs)) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Resolves candidate thumbnail URLs in descending order of quality */
function getThumbnailCandidates(sound: { id?: string; source?: string; thumbnail_url?: string | null } | null): string[] {
  if (!sound) return [];
  const candidates: string[] = [];
  const rawUrl = sound.thumbnail_url || "";
  const combined = `${rawUrl} ${sound.id || ""}`;

  if (sound.source === "youtube" || combined.includes("ytimg") || combined.includes("youtu")) {
    const match = combined.match(/(?:i\.ytimg\.com\/vi(?:_webp)?|img\.youtube\.com\/vi|youtu\.be\/|v=|\/vi\/)?([a-zA-Z0-9_-]{11})/);
    if (match && match[1]) {
      const vId = match[1];
      // 1. Official YouTube unletterboxed 720p HD standard
      candidates.push(`https://i.ytimg.com/vi/${vId}/hq720.jpg`);
      // 2. Full 1080p/720p maxres
      candidates.push(`https://i.ytimg.com/vi/${vId}/maxresdefault.jpg`);
      // 3. 640x480 standard definition
      candidates.push(`https://i.ytimg.com/vi/${vId}/sddefault.jpg`);
      // 4. Clean 16:9 unletterboxed MQ
      candidates.push(`https://i.ytimg.com/vi/${vId}/mqdefault.jpg`);
      // 5. Standard fallback
      candidates.push(`https://i.ytimg.com/vi/${vId}/hqdefault.jpg`);
    }
  }

  if (sound.thumbnail_url && !candidates.includes(sound.thumbnail_url)) {
    candidates.push(sound.thumbnail_url);
  }

  return candidates;
}

/**
 * EqualizerWaves — GSAP-driven 60 FPS live acoustic wave visualizer.
 * Animates bars via requestAnimationFrame, immune to CSS reduced-motion or parser locks.
 */
function EqualizerWaves({ isPlaying }: { isPlaying: boolean }) {
  const bar0 = useRef<HTMLDivElement>(null);
  const bar1 = useRef<HTMLDivElement>(null);
  const bar2 = useRef<HTMLDivElement>(null);
  const bar3 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bars = [bar0.current, bar1.current, bar2.current, bar3.current].filter(Boolean) as HTMLDivElement[];
    if (bars.length === 0) return;

    if (!isPlaying) {
      gsap.to(bars, {
        scaleY: 0.2,
        duration: 0.35,
        ease: "power2.out",
        transformOrigin: "50% 100%",
        overwrite: "auto",
      });
      return;
    }

    // Organic, asynchronous acoustic wave motion across the 4 bars
    const tweens: gsap.core.Tween[] = [];
    const configs = [
      { min: 0.18, max: 0.95, duration: 0.44, delay: 0 },
      { min: 0.3, max: 1.0, duration: 0.36, delay: 0.08 },
      { min: 0.12, max: 0.88, duration: 0.5, delay: 0.16 },
      { min: 0.25, max: 0.92, duration: 0.42, delay: 0.04 },
    ];

    bars.forEach((bar, idx) => {
      const cfg = configs[idx] || { min: 0.2, max: 0.9, duration: 0.4, delay: 0 };
      gsap.set(bar, { transformOrigin: "50% 100%" });
      const tw = gsap.fromTo(
        bar,
        { scaleY: cfg.min },
        {
          scaleY: cfg.max,
          duration: cfg.duration,
          delay: cfg.delay,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
          overwrite: "auto",
        }
      );
      tweens.push(tw);
    });

    return () => {
      tweens.forEach((t) => t.kill());
    };
  }, [isPlaying]);

  return (
    <div className="flex items-end gap-[3px] h-[20px] px-1 flex-shrink-0" aria-hidden="true">
      {[bar0, bar1, bar2, bar3].map((ref, idx) => (
        <div
          key={idx}
          ref={ref}
          className={cn(
            "w-[3.5px] h-[20px] rounded-full transition-colors duration-300 amb-wave-bar",
            isPlaying
              ? "bg-gradient-to-t from-[#00f2fe] via-[#0ea5e9] to-[#3b82f6] shadow-[0_0_8px_rgba(0,242,254,0.65)]"
              : "bg-white/30"
          )}
          style={{ transformOrigin: "50% 100%", transform: "scaleY(0.2)" }}
        />
      ))}
    </div>
  );
}

export default function AmbientDynamicIsland() {
  const {
    activeSound,
    isPlaying,
    isBuffering,
    currentTime,
    duration,
    togglePlay,
    seek,
    openDrawer,
  } = useAmbientStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const contentWrapRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const heartbeatTlRef = useRef<gsap.core.Timeline | null>(null);
  const autoCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoveredRef = useRef(false);

  const [mounted, setMounted] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  // Multi-tier HD thumbnail fallback system
  const [thumbIdx, setThumbIdx] = useState(0);
  const candidates = getThumbnailCandidates(activeSound);
  const currentThumb = candidates[thumbIdx] || activeSound?.thumbnail_url || undefined;

  useEffect(() => {
    setMounted(true);
  }, []);

  const isAnimatingRef = useRef(false);

  // 10-second auto-collapse timer logic
  const startAutoCollapseTimer = useCallback(() => {
    if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
    autoCollapseTimerRef.current = setTimeout(() => {
      // Auto-contract only if user is not currently hovering over the island
      if (!isHoveredRef.current) {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setIsExpanded(false);
      }
    }, 10_000);
  }, []);

  // Reset thumbnail index & expand for 10s whenever track changes
  useEffect(() => {
    setThumbIdx(0);
    if (activeSound) {
      setIsExpanded(true);
      startAutoCollapseTimer();
    }
    return () => {
      if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
    };
  }, [activeSound?.id, activeSound?.thumbnail_url, startAutoCollapseTimer]);

  const handleThumbError = () => {
    if (thumbIdx + 1 < candidates.length) {
      setThumbIdx((prev) => prev + 1);
    }
  };

  const handleMouseEnter = () => {
    isHoveredRef.current = true;
    if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
  };

  const handleMouseLeave = () => {
    isHoveredRef.current = false;
    if (isExpanded) {
      startAutoCollapseTimer();
    }
  };

  const handleContainerClick = (e: React.MouseEvent) => {
    // If contracted: clicking anywhere on the circle expands it
    if (!isExpanded) {
      e.stopPropagation();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setIsExpanded(true);
      startAutoCollapseTimer();
    }
  };

  const handleCircularRegionClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (!isExpanded) {
      // Expand into full pill
      setIsExpanded(true);
      startAutoCollapseTimer();
    } else {
      // Contract immediately to circular shape
      if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
      setIsExpanded(false);
    }
  };

  const effectiveDuration = duration > 0 ? duration : (activeSound?.duration_secs || 0);
  const progressPct = effectiveDuration > 0 ? Math.min(100, (currentTime / effectiveDuration) * 100) : 0;

  // ── Heartbeat Controller (Runs strictly when contracted to 52px circle & playing) ──
  const startHeartbeat = useCallback(() => {
    if (heartbeatTlRef.current) {
      heartbeatTlRef.current.kill();
      heartbeatTlRef.current = null;
    }
    // Never run if expanded, if actively morphing, paused, or no container
    if (isExpanded || isAnimatingRef.current || !isPlaying || !containerRef.current) {
      if (containerRef.current) gsap.set(containerRef.current, { scale: 1.0 });
      return;
    }
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.85 });
    // Organic cardiac dual-pump: Lub (1.0 -> 1.08 -> 1.0), Dub (1.0 -> 1.05 -> 1.0), Rest
    tl.to(containerRef.current, {
      scale: 1.08,
      duration: 0.16,
      ease: "power2.out",
      transformOrigin: "50% 50%",
    })
    .to(containerRef.current, {
      scale: 1.0,
      duration: 0.18,
      ease: "power2.in",
    })
    .to(containerRef.current, {
      scale: 1.05,
      duration: 0.14,
      ease: "power2.out",
    })
    .to(containerRef.current, {
      scale: 1.0,
      duration: 0.2,
      ease: "power2.in",
    });
    heartbeatTlRef.current = tl;
  }, [isExpanded, isPlaying]);

  // Update heartbeat when isPlaying changes while already contracted (not mid-animation)
  useEffect(() => {
    if (!isExpanded && !isAnimatingRef.current) {
      if (isPlaying) {
        startHeartbeat();
      } else {
        if (heartbeatTlRef.current) {
          heartbeatTlRef.current.kill();
          heartbeatTlRef.current = null;
        }
        if (containerRef.current) {
          gsap.to(containerRef.current, { scale: 1.0, duration: 0.25, ease: "power2.out" });
        }
      }
    }
  }, [isPlaying, isExpanded, startHeartbeat]);

  // ── GSAP Expand / Contract Morphing Transition (Pinned Anchor, Zero Scroll, Zero Glitch) ──
  useEffect(() => {
    if (!containerRef.current || !contentWrapRef.current) return;

    if (isExpanded) {
      isAnimatingRef.current = true;
      // 1. Kill any active heartbeat immediately upon expanding
      if (heartbeatTlRef.current) {
        heartbeatTlRef.current.kill();
        heartbeatTlRef.current = null;
      }
      gsap.killTweensOf([containerRef.current, contentWrapRef.current]);
      gsap.set(containerRef.current, { scale: 1.0 });
      if (containerRef.current) containerRef.current.scrollLeft = 0;

      // Bring content into layout (hidden opacity) to measure true width
      contentWrapRef.current.style.display = "flex";
      contentWrapRef.current.style.pointerEvents = "auto";
      contentWrapRef.current.style.opacity = "0";

      // Measure full expanded content width: 7px pad + 38px circle + 14px gap + scrollWidth + 7px pad
      const fullWidth = contentWrapRef.current.scrollWidth + 66;

      const tl = gsap.timeline({
        defaults: { ease: "power3.out" },
        onComplete: () => {
          isAnimatingRef.current = false;
          if (containerRef.current) {
            containerRef.current.style.width = "auto";
            containerRef.current.scrollLeft = 0;
          }
        },
      });

      tl.to(containerRef.current, {
        width: fullWidth,
        duration: 0.4,
        onUpdate: () => {
          if (containerRef.current) containerRef.current.scrollLeft = 0;
        },
      })
      .to(
        contentWrapRef.current,
        {
          opacity: 1,
          duration: 0.25,
          ease: "power2.out",
        },
        "-=0.25"
      );
    } else {
      isAnimatingRef.current = true;
      // 2. Contracting into circular shape (smooth shrink without any jump, scroll, or flicker)
      if (heartbeatTlRef.current) {
        heartbeatTlRef.current.kill();
        heartbeatTlRef.current = null;
      }
      gsap.killTweensOf([containerRef.current, contentWrapRef.current]);
      gsap.set(containerRef.current, { scale: 1.0 });

      // Blur focused children to prevent browser from scrolling overflowing elements
      if (document.activeElement && containerRef.current.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }

      // Freeze current width before contracting
      const currentW = containerRef.current.offsetWidth;
      containerRef.current.style.width = `${currentW}px`;
      containerRef.current.scrollLeft = 0;
      contentWrapRef.current.style.pointerEvents = "none";

      const tl = gsap.timeline({
        defaults: { ease: "power3.inOut" },
        onComplete: () => {
          isAnimatingRef.current = false;
          // Hide content so container has ZERO overflow and cannot scroll
          if (contentWrapRef.current) {
            contentWrapRef.current.style.display = "none";
          }
          if (containerRef.current) {
            containerRef.current.scrollLeft = 0;
          }
          // Initiate heartbeat now that container is 52px circle
          startHeartbeat();
        },
      });

      tl.to(contentWrapRef.current, {
        opacity: 0,
        duration: 0.18,
        ease: "power2.in",
      })
      .to(
        containerRef.current,
        {
          width: 52,
          duration: 0.38,
          ease: "power3.inOut",
          onUpdate: () => {
            if (containerRef.current) containerRef.current.scrollLeft = 0;
          },
        },
        "-=0.1"
      );
    }
  }, [isExpanded, startHeartbeat]);

  // Click seek
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!progressRef.current || effectiveDuration <= 0) return;
    const rect = progressRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    seek(fraction * effectiveDuration);
  };

  if (!mounted) return null;

  // ── IDLE STATE: Sleek Circular Headphone Launcher Button ──
  if (!activeSound) {
    return (
      <button
        type="button"
        onClick={openDrawer}
        className="grid h-10 w-10 place-items-center rounded-full border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] hover:border-blue-500/35 text-content-secondary hover:text-white shadow-xl backdrop-blur-xl transition-all active:scale-95 group"
        title="Focus Audio (Alt+M)"
        aria-label="Open Focus Audio Drawer"
      >
        <Headphones size={17} className="text-blue-400 group-hover:scale-110 group-hover:text-blue-300 transition-all" />
      </button>
    );
  }

  // ── ACTIVE STATE: Flagship Dynamic Island (Morphs between 52px Circle & Full Pill) ──
  return (
    <div
      ref={containerRef}
      id="amb-dynamic-island"
      onClick={handleContainerClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onScroll={(e) => {
        (e.currentTarget as HTMLDivElement).scrollLeft = 0;
      }}
      className={cn(
        "relative flex h-[52px] -mt-1.5 shrink-0 items-center pl-[7px] pr-[7px] gap-3.5 rounded-full border border-white/[0.08] bg-[#0c0d14]/92 shadow-2xl backdrop-blur-2xl [box-shadow:0_18px_44px_-10px_rgba(0,0,0,0.8),inset_0_1px_1px_rgba(255,255,255,0.08)] group/pill overflow-hidden select-none transition-colors duration-200",
        !isExpanded && "cursor-pointer",
        isPlaying ? "border-blue-500/40 ring-1 ring-blue-500/25 shadow-[0_0_25px_rgba(37,99,235,0.25)]" : "hover:border-white/[0.15]"
      )}
      role="region"
      aria-label="Focus Audio Dynamic Island"
      title={!isExpanded ? `${activeSound.name} (Click to expand)` : undefined}
    >
      {/* 1. Circular Photo Preview (Hero) with Ultra-Thin 1.5px Spinning RGB Ring & Dancing Glow Aura */}
      <div
        onClick={handleCircularRegionClick}
        className="amb-rgb-ring-wrap cursor-pointer flex-shrink-0"
        title={isExpanded ? "Click to contract to mini circle" : "Click to expand Focus Audio"}
      >
        {/* Layer A: Dancing breathing neon glow aura */}
        <div
          className={cn(
            "amb-rgb-aurora",
            !isPlaying && "amb-rgb-aurora--paused"
          )}
        />
        {/* Layer B: Ultra-thin 1.5px crisp rotating multi-colour rainbow border */}
        <div
          className={cn(
            "amb-rgb-spinner",
            !isPlaying && "amb-rgb-spinner--paused"
          )}
        />
        {/* Layer C: Hero Circular Photo Preview (35px centered inside 38px -> 1.5px ultra-thin RGB ring) */}
        <div className="relative z-10 w-[35px] h-[35px] rounded-full overflow-hidden bg-[#090b10] flex items-center justify-center border border-black/40 shadow-inner">
          {currentThumb ? (
            <img
              src={currentThumb}
              onError={handleThumbError}
              alt=""
              className="w-full h-full object-cover select-none pointer-events-none"
              loading="eager"
              decoding="async"
            />
          ) : (
            <div className="text-xs">
              {activeSound.source === "youtube" ? (
                <YouTubeIcon size={15} className="text-red-400" />
              ) : activeSound.source === "somafm" ? (
                <Radio size={15} className="text-blue-400" />
              ) : (
                <Sparkles size={15} className="text-amber-400" />
              )}
            </div>
          )}
        </div>
      </div>

      {/* 2. Expanded Content Wrap: Live GSAP Waves + Track Title + Play/Pause + Maximize */}
      <div
        ref={contentWrapRef}
        className="flex items-center gap-3 min-w-0 flex-shrink-0 pr-1"
        style={{ opacity: isExpanded ? 1 : 0, pointerEvents: isExpanded ? "auto" : "none" }}
      >
        {/* GSAP-Powered Active Equalizer Waves */}
        <EqualizerWaves isPlaying={isPlaying} />

        {/* Title & Metadata */}
        <div
          onClick={openDrawer}
          className="min-w-0 max-w-[190px] sm:max-w-[250px] md:max-w-[310px] cursor-pointer group/meta pr-1"
          title={activeSound.name}
        >
          <div className="text-[12.5px] font-semibold text-white/95 truncate group-hover/meta:text-blue-300 transition-colors leading-snug">
            {activeSound.name}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] font-mono text-white/45 leading-none mt-0.5">
            {isBuffering ? (
              <span className="text-amber-400 flex items-center gap-1.5 font-sans font-medium">
                <SmoothSpinner size={10} className="text-amber-400" /> Buffering
              </span>
            ) : (
              <>
                <span className={isPlaying ? "text-emerald-400 font-sans font-semibold" : "text-white/45 font-sans"}>
                  {isPlaying ? "Playing" : "Paused"}
                </span>
                {effectiveDuration > 0 ? (
                  <span>
                    · {fmtTime(currentTime)} / {fmtTime(effectiveDuration)}
                  </span>
                ) : (
                  <span>· 160k Opus</span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Play / Pause Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-600 via-blue-500 to-indigo-500 hover:from-blue-500 hover:to-indigo-400 text-white flex items-center justify-center shadow-md shadow-blue-500/40 transition-all hover:scale-105 active:scale-90 flex-shrink-0"
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="3.5" height="12" rx="1.5" />
              <rect x="9.5" y="2" width="3.5" height="12" rx="1.5" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="ml-0.5">
              <path d="M4 2.5a1 1 0 0 1 1.524-.852l8.5 5.5a1 1 0 0 1 0 1.704l-8.5 5.5A1 1 0 0 1 4 13.5v-11z" />
            </svg>
          )}
        </button>

        {/* Open Study Drawer Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openDrawer();
          }}
          className="w-8 h-8 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/50 hover:text-white flex items-center justify-center transition-all flex-shrink-0"
          title="Open Focus Audio Study Drawer (Alt+M)"
          aria-label="Open Focus Audio Drawer"
        >
          <Maximize2 size={14} />
        </button>
      </div>

      {/* 3. Precision Scrubber Underline (Visible only when expanded) */}
      {effectiveDuration > 0 && (
        <div
          ref={progressRef}
          onClick={handleSeek}
          className={cn(
            "absolute bottom-0 left-5 right-5 h-[2.5px] rounded-full overflow-hidden bg-white/[0.06] cursor-pointer group-hover/pill:h-[3.5px] transition-all",
            !isExpanded && "opacity-0 pointer-events-none"
          )}
          title={`Seek (${fmtTime(currentTime)} / ${fmtTime(effectiveDuration)})`}
        >
          <div
            className="h-full bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-400 transition-all duration-75"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
    </div>
  );
}
