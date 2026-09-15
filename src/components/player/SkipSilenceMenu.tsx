/**
 * Skip Silence settings popover — presentational only. Opaque (`bg-ink-850`) to respect the
 * transparent-window rule (mpv renders behind the webview; a translucent panel over the video
 * viewport would bleed the desktop through).
 *
 * Enhanced with GSAP entrance micro-animations, tactile feedback, sleek filled-track slider,
 * and high-contrast dark theme aesthetics.
 *
 * All state lives in `useSkipSilence`; this component renders `settings` and calls `onChange`.
 */

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { Zap } from "lucide-react";
import {
  MIN_SILENCE_OPTIONS,
  SKIP_SPEED_OPTIONS,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  type SkipSilenceSettings,
} from "./useSkipSilence";
import { formatRate } from "../../lib/playbackRate";

interface Props {
  settings: SkipSilenceSettings;
  onChange: (patch: Partial<SkipSilenceSettings>) => void;
}

export default function SkipSilenceMenu({ settings, onChange }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Smooth entrance micro-animation with GSAP
  useEffect(() => {
    if (menuRef.current) {
      gsap.fromTo(
        menuRef.current,
        { opacity: 0, y: 10, scale: 0.95 },
        { opacity: 1, y: 0, scale: 1, duration: 0.22, ease: "power3.out" },
      );
    }
  }, []);

  // Calculate percentage fill for the custom slider track
  const sliderFillPercent =
    ((settings.thresholdDb - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN)) * 100;

  return (
    <div
      ref={menuRef}
      className="absolute bottom-11 right-0 z-30 w-[280px] rounded-2xl border border-white/[0.12] bg-[#141416] p-3.5 text-left shadow-[0_20px_50px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.06)] backdrop-blur-none"
    >
      {/* Header + Master Toggle */}
      <div className="mb-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={
              "flex h-6 w-6 items-center justify-center rounded-lg border transition-all duration-200 " +
              (settings.enabled
                ? "border-lime/40 bg-lime/10 text-lime shadow-[0_0_12px_rgba(170,255,0,0.2)]"
                : "border-white/10 bg-white/[0.04] text-content-faint")
            }
          >
            <Zap size={13} className={settings.enabled ? "fill-lime/30" : ""} />
          </div>
          <div>
            <div className="text-xs font-semibold leading-tight text-content-primary">
              Skip Silence
            </div>
            <div className="text-[10px] leading-tight text-content-faint">
              {settings.enabled ? "Smart lecture pacing active" : "Disabled"}
            </div>
          </div>
        </div>

        {/* Master switch */}
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => onChange({ enabled: !settings.enabled })}
          className={
            "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-lime/50 " +
            (settings.enabled
              ? "bg-lime shadow-[0_0_12px_rgba(170,255,0,0.4)]"
              : "bg-white/15 hover:bg-white/20")
          }
          aria-label="Enable skip silence"
          title="Enable skip silence (Ctrl+Shift+S)"
        >
          <span
            className={
              "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-md transition-all duration-200 " +
              (settings.enabled ? "left-[18px]" : "left-0.5")
            }
          />
        </button>
      </div>

      {/* Mode segmented control */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-content-faint">
          <span>Mode</span>
          <span className="text-[9px] font-normal normal-case text-content-faint">
            {settings.mode === "smooth" ? "Progressive ramp" : "Instant jump"}
          </span>
        </div>
        <div className="flex gap-1 rounded-xl border border-white/[0.08] bg-black/40 p-1">
          {(["smooth", "instant"] as const).map((m) => {
            const active = settings.mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onChange({ mode: m })}
                className={
                  "flex-1 rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-all duration-150 active:scale-[0.98] " +
                  (active
                    ? "border border-white/10 bg-white/[0.12] text-content-primary shadow-sm"
                    : "text-content-secondary hover:bg-white/[0.04] hover:text-content-primary")
                }
              >
                {m === "smooth" ? "Smooth" : "Instant"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Sensitivity Threshold Slider */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-content-faint">
          <span>Sensitivity</span>
          <span className="rounded-md border border-lime/25 bg-lime/10 px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums text-lime">
            {settings.thresholdDb} dB
          </span>
        </div>
        <div className="relative flex items-center py-1">
          <input
            type="range"
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={1}
            value={settings.thresholdDb}
            onChange={(e) => onChange({ thresholdDb: Number(e.target.value) })}
            style={{
              background: `linear-gradient(to right, #AAFF00 ${sliderFillPercent}%, rgba(255, 255, 255, 0.15) ${sliderFillPercent}%)`,
            }}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-lime transition-all focus:outline-none"
            aria-label="Silence sensitivity threshold in decibels"
          />
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-content-faint">
          <span>Quiet room (-40 dB)</span>
          <span>Noisy (-25 dB)</span>
        </div>
      </div>

      {/* Minimum Silence */}
      <div className="mb-3">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-content-faint">
          Min. Silence
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {MIN_SILENCE_OPTIONS.map((s) => {
            const active = settings.minSilenceSecs === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onChange({ minSilenceSecs: s })}
                className={
                  "rounded-lg border px-2 py-1 text-center text-xs font-medium tabular-nums transition-all duration-150 active:scale-95 " +
                  (active
                    ? "border-lime/50 bg-lime/15 text-lime shadow-[0_0_12px_rgba(170,255,0,0.15)]"
                    : "border-white/10 bg-white/[0.03] text-content-secondary hover:border-white/20 hover:bg-white/[0.06] hover:text-content-primary")
                }
              >
                {s}s
              </button>
            );
          })}
        </div>
      </div>

      {/* Skip Speed */}
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-content-faint">
          <span>Skip Speed</span>
          {settings.mode === "instant" && (
            <span className="rounded border border-lime/20 bg-lime/[0.08] px-1.5 py-0.5 text-[9px] font-medium text-lime/80">
              Instant uses 4×
            </span>
          )}
        </div>
        <div
          className={
            "grid grid-cols-6 gap-1 transition-opacity duration-200 " +
            (settings.mode === "instant" ? "pointer-events-none select-none opacity-35" : "")
          }
        >
          {SKIP_SPEED_OPTIONS.map((s) => {
            const active = settings.skipSpeed === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onChange({ skipSpeed: s })}
                className={
                  "rounded-lg border px-1 py-1 text-center text-xs font-medium tabular-nums transition-all duration-150 active:scale-95 " +
                  (active
                    ? "border-lime/50 bg-lime/15 text-lime shadow-[0_0_12px_rgba(170,255,0,0.15)]"
                    : "border-white/10 bg-white/[0.03] text-content-secondary hover:border-white/20 hover:bg-white/[0.06] hover:text-content-primary")
                }
              >
                {formatRate(s)}×
              </button>
            );
          })}
        </div>
      </div>

      {/* Footer hint & status */}
      <div className="mt-3.5 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[9px] text-content-faint">
        <span className="flex items-center gap-1">
          <Zap size={10} className="text-lime" />
          <span>Silences &gt;3s sprint at 8×</span>
        </span>
        <span className="font-mono text-content-faint">Ctrl+Shift+S</span>
      </div>
    </div>
  );
}
