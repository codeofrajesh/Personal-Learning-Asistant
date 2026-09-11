/**
 * StreakBadge — professional animated streak badge celebrating consistency days.
 *
 * Visual & Animation Architecture:
 *   • GSAP IGNITION: Signature spring-loaded explosive jump on mount (scale 0.15 → 1.45 → 1.0)
 *     with back.out(3.2) elastic overshoot.
 *   • GSAP LIVING FIRE: Continuous 60fps organic sway & flicker, licking tongues, and core pulse.
 *   • MULTI-LAYERED SVG:
 *       1. Ambient Radiant Aura (breathing amber/orange halo)
 *       2. Outer Flame (ruby red #DC2626 → deep orange #EA580C → golden amber #FBBF24)
 *       3. Mid Licking Tongue (#F97316 → #FEF08A)
 *       4. White-Hot Incandescent Core (#FFFFFF to #FEF08A with glowing dropshadow)
 *       5. Rising Ember Spark micro-particles
 *   • SHORT & CLEAN COPY:
 *       - Sidebar: Flame + "{streak} days streak"
 *       - Header: Flame + "{streak} days streak"
 *       - Target Pace: Flame + "{streak}d streak"
 *       - Calendar: Flame + "{streak} days streak"
 *   • Returns `null` if `streak <= 0` (strictly invisible if no streak).
 */

import { useId, useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { cn } from "../../lib/utils";

export type StreakBadgeVariant = "header" | "pace" | "calendar" | "sidebar";

interface Props {
  streak: number;
  variant?: StreakBadgeVariant;
  collapsed?: boolean;
  className?: string;
}

export default function StreakBadge({
  streak,
  variant = "header",
  collapsed = false,
  className,
}: Props) {
  // If no streak is present, do not display anything at all
  if (!streak || streak <= 0) return null;

  const rootRef = useRef<HTMLDivElement>(null);
  const flameRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<SVGPathElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const flame = flameRef.current;
    const core = coreRef.current;
    if (!root || !flame) return;

    const ctx = gsap.context(() => {
      // 1. Signature Spring-Loaded Ignition Jump on Mount!
      const tl = gsap.timeline();
      tl.fromTo(
        flame,
        { scale: 0.15, y: 12, opacity: 0, rotation: -14 },
        {
          scale: 1.42,
          y: -7,
          opacity: 1,
          rotation: 8,
          duration: 0.45,
          ease: "back.out(3.2)",
        },
      ).to(flame, {
        scale: 1,
        y: 0,
        rotation: 0,
        duration: 0.25,
        ease: "power2.out",
      });

      // 2. Continuous Organic 60fps Flame Sway & Breathing Scale
      gsap.to(flame, {
        scaleY: 1.15,
        scaleX: 1.07,
        duration: 0.75,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        delay: 0.7,
      });

      gsap.to(flame, {
        rotation: -5,
        transformOrigin: "50% 90%",
        duration: 0.6,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        delay: 0.7,
      });

      // 3. White-Hot Core Pulse
      if (core) {
        gsap.to(core, {
          scale: 1.28,
          transformOrigin: "50% 90%",
          duration: 0.45,
          repeat: -1,
          yoyo: true,
          ease: "power1.inOut",
        });
      }

      // 4. Rising Micro-Spark Particles
      const sparks = root.querySelectorAll<HTMLElement>(".flame-spark");
      sparks.forEach((spark, i) => {
        gsap.to(spark, {
          y: -16 - i * 4,
          x: (i % 2 === 0 ? 1 : -1) * (3 + i * 2),
          opacity: 0,
          scale: 0.2,
          duration: 1.1 + i * 0.3,
          repeat: -1,
          delay: i * 0.35,
          ease: "power1.out",
        });
      });
    }, root);

    return () => ctx.revert();
  }, []);

  // ── VARIANT: SIDEBAR (EXPANDED OR COLLAPSED) ────────────────────────────────
  if (variant === "sidebar") {
    if (collapsed) {
      return (
        <div
          ref={rootRef}
          title={`${streak} day consistency streak!`}
          className={cn(
            "relative mx-auto my-1 grid h-10 w-10 place-items-center rounded-xl border border-amber-500/40 bg-gradient-to-br from-amber-500/25 via-orange-500/15 to-transparent shadow-[0_0_14px_rgba(245,158,11,0.35)] transition-transform hover:scale-105",
            className,
          )}
        >
          <div ref={flameRef} className="origin-bottom">
            <IndustryFlameSvg coreRef={coreRef} size={22} />
          </div>
          <span className="absolute -top-1 -right-1 grid h-4 min-w-[16px] place-items-center rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-1 text-[9px] font-black text-black shadow-[0_0_6px_rgba(245,158,11,0.8)]">
            {streak}
          </span>
        </div>
      );
    }

    return (
      <div
        ref={rootRef}
        className={cn(
          "relative mx-2 my-2 overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-transparent p-2.5 shadow-[0_0_16px_-2px_rgba(245,158,11,0.25)] backdrop-blur-md transition-all hover:border-amber-500/45 hover:shadow-[0_0_20px_-2px_rgba(245,158,11,0.35)]",
          className,
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="relative grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-amber-400/25 bg-amber-500/20 shadow-[inset_0_0_10px_rgba(245,158,11,0.25)]">
            <div ref={flameRef} className="origin-bottom">
              <IndustryFlameSvg coreRef={coreRef} size={20} />
            </div>
            {/* Spark 1 */}
            <span className="flame-spark pointer-events-none absolute top-1 right-2 h-1 w-1 rounded-full bg-amber-300 shadow-[0_0_4px_#fef08a]" />
            {/* Spark 2 */}
            <span className="flame-spark pointer-events-none absolute top-2 left-2 h-1 w-1 rounded-full bg-orange-400 shadow-[0_0_4px_#fb923c]" />
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-black tabular-nums text-white leading-none tracking-tight [text-shadow:0_0_8px_rgba(251,191,36,0.5)]">
              {streak}
            </span>
            <span className="text-xs font-semibold text-amber-200/90">
              {streak === 1 ? "day streak" : "days streak"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ── VARIANT: TARGET PACE CARD ───────────────────────────────────────────────
  if (variant === "pace") {
    return (
      <div
        ref={rootRef}
        title={`${streak} consecutive study days streak`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-amber-500/35 bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-transparent px-2.5 py-1 text-[0.68rem] shadow-[0_0_10px_rgba(245,158,11,0.2)] backdrop-blur-sm transition-transform hover:scale-105",
          className,
        )}
      >
        <div ref={flameRef} className="relative origin-bottom">
          <IndustryFlameSvg coreRef={coreRef} size={13} />
        </div>
        <span className="font-black tabular-nums text-amber-300">{streak}d</span>
        <span className="font-semibold text-amber-200/90">streak</span>
      </div>
    );
  }

  // ── VARIANT: CONSISTENCY CALENDAR TOP RIGHT ─────────────────────────────────
  if (variant === "calendar") {
    return (
      <div
        ref={rootRef}
        title={`${streak} consecutive study days consistency`}
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-amber-500/35 bg-gradient-to-r from-amber-500/20 via-orange-500/15 to-amber-500/5 px-3 py-1 text-[0.72rem] shadow-[0_0_14px_rgba(245,158,11,0.25)] backdrop-blur-md transition-all hover:border-amber-500/50 hover:scale-105",
          className,
        )}
      >
        <div ref={flameRef} className="relative origin-bottom">
          <IndustryFlameSvg coreRef={coreRef} size={15} />
        </div>
        <span className="font-black tabular-nums text-white text-xs [text-shadow:0_0_6px_rgba(251,191,36,0.6)]">
          {streak}
        </span>
        <span className="font-semibold text-amber-200/90">
          {streak === 1 ? "day streak" : "days streak"}
        </span>
      </div>
    );
  }

  // ── DEFAULT VARIANT: HEADER (TOP STEPPER BAR NEXT TO PERIOD PILL) ───────────
  return (
    <div
      ref={rootRef}
      title={`${streak} consecutive study days`}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-amber-500/35 bg-gradient-to-r from-amber-500/20 via-orange-500/15 to-amber-500/5 px-3 py-1 shadow-[0_0_16px_rgba(245,158,11,0.25)] backdrop-blur-md transition-all duration-200 hover:border-amber-500/50 hover:scale-105",
        className,
      )}
    >
      <div className="relative">
        <div ref={flameRef} className="relative origin-bottom">
          <IndustryFlameSvg coreRef={coreRef} size={16} />
        </div>
        <span className="flame-spark pointer-events-none absolute -top-1 right-0 h-1 w-1 rounded-full bg-amber-300 shadow-[0_0_4px_#fef08a]" />
        <span className="flame-spark pointer-events-none absolute -top-2 left-0.5 h-0.5 w-0.5 rounded-full bg-orange-400 shadow-[0_0_3px_#fb923c]" />
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="font-black tabular-nums text-amber-300 text-sm [text-shadow:0_0_8px_rgba(251,191,36,0.6)]">
          {streak}
        </span>
        <span className="text-xs font-semibold text-amber-200/90">
          {streak === 1 ? "day streak" : "days streak"}
        </span>
      </div>
    </div>
  );
}

// ── Multi-Layered Industry Grade SVG Flame with Glowing Core & Aura ───────────

function IndustryFlameSvg({
  coreRef,
  size = 20,
}: {
  coreRef?: React.Ref<SVGPathElement>;
  size?: number;
}) {
  const rawId = useId();
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, "_");

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      data-flame="true"
      className="shrink-0 overflow-visible industry-flame"
      style={{
        filter: "drop-shadow(0 0 6px rgba(245, 158, 11, 0.75)) drop-shadow(0 0 12px rgba(239, 68, 68, 0.35))",
      }}
      aria-hidden="true"
    >
      <defs>
        {/* Outer Flame Gradient */}
        <linearGradient id={`indFlameOuter_${id}`} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#DC2626" />
          <stop offset="35%" stopColor="#EA580C" />
          <stop offset="70%" stopColor="#F59E0B" />
          <stop offset="100%" stopColor="#FBBF24" />
        </linearGradient>

        {/* Mid Flame Tongue Gradient */}
        <linearGradient id={`indFlameMid_${id}`} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#F97316" />
          <stop offset="60%" stopColor="#FBBF24" />
          <stop offset="100%" stopColor="#FEF08A" />
        </linearGradient>

        {/* White-Hot Core Gradient */}
        <linearGradient id={`indFlameCore_${id}`} x1="0%" y1="100%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#FBBF24" />
          <stop offset="40%" stopColor="#FEF08A" />
          <stop offset="100%" stopColor="#FFFFFF" />
        </linearGradient>

        {/* Radiant Heat Aura Gradient */}
        <radialGradient id={`indFlameAura_${id}`} cx="50%" cy="65%" r="50%">
          <stop offset="0%" stopColor="#FBBF24" stopOpacity="0.75" />
          <stop offset="50%" stopColor="#F97316" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#DC2626" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Layer 1: Ambient Radiant Heat Aura */}
      <circle
        cx="12"
        cy="13"
        r="9"
        fill={`url(#indFlameAura_${id})`}
        className="pointer-events-none"
      />

      {/* Layer 2: Main Outer Flame Body */}
      <path
        d="M12 2C10.5 4.5 8 7 8 10.5c0 1.2.4 2.3 1 3.2-.2-.8-.2-1.7.1-2.5 1 2 2.5 3 4.5 3.5-1-1.5-1.5-3.2-.5-5.2C14.5 7.2 16 5.5 16 3c2 2.5 3.5 5.5 3.5 9 0 4.142-3.358 7.5-7.5 7.5S4.5 16.142 4.5 12c0-3.5 2-6.5 4.5-8.5C8 5 7.5 6.5 7.5 8c0 1.2.3 2.3.8 3.2C8.1 9.8 8.2 8.5 9 7.2 10 5.6 11 3.8 12 2z"
        fill={`url(#indFlameOuter_${id})`}
      />

      {/* Layer 3: Mid Licking Tongue */}
      <path
        d="M12 7c-.8 1.5-1.8 2.8-1.8 4.5 0 1.8 1.2 3.2 2.8 3.5-.8-.9-.9-2-.4-3 .6 1 1.4 1.8 2.4 2.2-.2-1.2-.1-2.2.5-3.2.7-1.2 1-2 1-3.5 1 1.5 1.5 3 1.5 4.8 0 2.8-2.2 5.2-5 5.2s-5-2.4-5-5.2c0-2.2 1.2-4.2 2.8-5.3-.3.8-.4 1.6-.4 2.3 0 .7.2 1.4.6 2 .1-.8.2-1.5.8-2.3.5-1 1-1.6 1.2-2z"
        fill={`url(#indFlameMid_${id})`}
        opacity="0.95"
      />

      {/* Layer 4: White-Hot Incandescent Core */}
      <path
        ref={coreRef}
        d="M12 12.5c-.8 1-1.2 2-1.2 3.2 0 1.5 1.1 2.8 2.4 2.8s2.4-1.3 2.4-2.8c0-1.2-.6-2.2-1.4-3.2.2.6.1 1.2-.2 1.6-.3.4-.8.6-1.2.4.2-.7.1-1.4-.8-2z"
        fill={`url(#indFlameCore_${id})`}
        style={{
          filter: "drop-shadow(0 0 3px #FFFFFF) drop-shadow(0 0 6px #FEF08A)",
        }}
      />
    </svg>
  );
}
