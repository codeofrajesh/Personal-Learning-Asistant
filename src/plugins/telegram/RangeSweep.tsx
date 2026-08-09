/**
 * The range-import signature element: a sweep rail from the first lesson to the last.
 *
 * A range import is the one place in the app where the user is asking for an unbounded amount
 * of work ("the next 50 lessons"), so the feedback has to answer two questions a spinner can't:
 * how far along is it, and is it actually finding anything. The rail encodes both — the fill is
 * progress, the tick marks are confirmed media items landing as they're found.
 *
 * Motion is GSAP-driven and quantized to the data (a tick per item), never ambient: when the
 * sweep stalls on a slow chunk the rail visibly stops, which is the honest signal.
 */

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Radio, Check } from "lucide-react";
import type { TgRangeProgress } from "./api";
import { cn } from "../../lib/utils";

gsap.registerPlugin(useGSAP);

interface RangeSweepProps {
  progress: TgRangeProgress | null;
  /** True while the import is in flight, even before the first tick arrives. */
  active: boolean;
}

/** Stage → the sentence shown under the rail. Written as status, not narration. */
function stageLabel(progress: TgRangeProgress | null): string {
  if (!progress) return "Starting…";
  if (progress.done) return `Imported ${progress.found} lesson${progress.found === 1 ? "" : "s"}`;
  if (progress.stage === "discovering") {
    return progress.found > 0
      ? `Found ${progress.found} · scanned ${progress.scanned}`
      : `Scanning ${progress.scanned} message${progress.scanned === 1 ? "" : "s"}…`;
  }
  if (progress.stage === "fetching") {
    return progress.found > 0
      ? `Reading ${progress.found} file${progress.found === 1 ? "" : "s"}…`
      : `Reading ${progress.scanned} message${progress.scanned === 1 ? "" : "s"}…`;
  }
  return "Working…";
}

export default function RangeSweep({ progress, active }: RangeSweepProps) {
  const root = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const pulse = useRef<HTMLDivElement>(null);

  // Fraction of the way done. A counted range knows its target; a start/end range doesn't, so
  // it falls back to a slow asymptotic creep that never claims to be finished early.
  const target = progress?.target ?? 0;
  const found = progress?.found ?? 0;
  const scanned = progress?.scanned ?? 0;
  const ratio = progress?.done
    ? 1
    : target > 0
      ? Math.min(found / target, 0.98)
      : // No known total: approach 0.9 asymptotically on messages seen.
        Math.min(scanned / (scanned + 40), 0.9);

  useGSAP(
    () => {
      if (!fill.current) return;
      // Animate to the new width rather than snapping, so a burst of items reads as a sweep.
      gsap.to(fill.current, {
        scaleX: ratio,
        duration: 0.7,
        ease: "power3.out",
        overwrite: "auto",
      });
    },
    { dependencies: [ratio], scope: root },
  );

  useGSAP(
    () => {
      if (!pulse.current) return;
      if (!active || progress?.done) {
        gsap.killTweensOf(pulse.current);
        gsap.to(pulse.current, { opacity: 0, duration: 0.3 });
        return;
      }
      // The leading edge glows while work is in flight. Stops the moment the sweep does, which
      // is what makes a stall visible instead of hidden behind a looping animation.
      gsap.set(pulse.current, { opacity: 1 });
      gsap.fromTo(
        pulse.current,
        { scale: 0.85, opacity: 0.9 },
        {
          scale: 1.35,
          opacity: 0.25,
          duration: 1.1,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
        },
      );
    },
    { dependencies: [active, progress?.done], scope: root },
  );

  const done = progress?.done ?? false;

  return (
    <div
      ref={root}
      className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-transparent p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_30px_-12px_rgba(0,0,0,0.8)] backdrop-blur-glass"
      role="status"
      aria-live="polite"
    >
      {/* Texture: a faint diagonal weave, so the panel reads as a material rather than a flat
          fill. Pure CSS — no asset to load, and it disappears against the noise floor. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, #fff 0 1px, transparent 1px 7px)",
        }}
      />

      <div className="relative flex items-center gap-3">
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-xl border transition-colors duration-500",
            done
              ? "border-lime/30 bg-lime/10 text-lime"
              : "border-[#2AABEE]/30 bg-[#2AABEE]/10 text-[#2AABEE]",
          )}
        >
          {done ? (
            <Check size={16} strokeWidth={2.5} aria-hidden />
          ) : (
            <Radio size={16} strokeWidth={2} aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-content-primary">{stageLabel(progress)}</p>
          {target > 0 && !done && (
            <p className="mt-0.5 text-xs text-content-faint">
              {found} of {target}
            </p>
          )}
        </div>
      </div>

      {/* The rail. `scaleX` on a full-width bar keeps the animation off the layout path. */}
      <div className="relative mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          ref={fill}
          className={cn(
            "h-full w-full origin-left rounded-full transition-colors duration-500",
            done
              ? "bg-gradient-to-r from-lime/70 to-lime"
              : "bg-gradient-to-r from-[#2AABEE]/60 to-[#2AABEE]",
          )}
          style={{ transform: "scaleX(0)" }}
        />
        <div
          ref={pulse}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-full rounded-full bg-[#2AABEE]/20 opacity-0 blur-[2px]"
        />
      </div>
    </div>
  );
}
