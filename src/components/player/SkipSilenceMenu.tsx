/**
 * Skip Silence settings popover — presentational only. Opaque (`bg-ink-850`) to respect the
 * transparent-window rule (mpv renders behind the webview; a translucent panel over the video
 * viewport would bleed the desktop through). Mirrors the speed menu's chrome.
 *
 * All state lives in `useSkipSilence`; this component just renders `settings` and calls
 * `onChange` with a patch.
 */

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
  return (
    <div className="absolute bottom-11 right-0 z-20 w-64 rounded-btn border border-white/10 bg-ink-850 p-3 text-left shadow-card">
      {/* Header + master toggle */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-content-primary">Skip Silence</span>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => onChange({ enabled: !settings.enabled })}
          className={
            "relative h-5 w-9 shrink-0 rounded-full transition-colors " +
            (settings.enabled ? "bg-lime" : "bg-white/15")
          }
          aria-label="Enable skip silence"
          title="Enable skip silence (Ctrl+Shift+S)"
        >
          <span
            className={
              "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all " +
              (settings.enabled ? "left-[18px]" : "left-0.5")
            }
          />
        </button>
      </div>

      {/* Mode */}
      <div className="mb-3">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-content-faint">Mode</div>
        <div className="flex gap-1 rounded-btn border border-white/[0.06] bg-white/[0.02] p-1">
          {(["smooth", "instant"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onChange({ mode: m })}
              className={
                "flex-1 rounded-[6px] px-2 py-1 text-xs font-medium capitalize transition-colors " +
                (settings.mode === m
                  ? "bg-white/[0.08] text-content-primary"
                  : "text-content-secondary hover:bg-white/[0.04]")
              }
            >
              {m === "smooth" ? "Smooth" : "Instant"}
            </button>
          ))}
        </div>
      </div>

      {/* Sensitivity threshold */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-content-faint">
          <span>Sensitivity</span>
          <span className="tabular-nums text-content-secondary">{settings.thresholdDb} dB</span>
        </div>
        <input
          type="range"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={1}
          value={settings.thresholdDb}
          onChange={(e) => onChange({ thresholdDb: Number(e.target.value) })}
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-lime"
          aria-label="Silence sensitivity threshold in decibels"
        />
        <div className="mt-0.5 flex justify-between text-[9px] text-content-faint">
          <span>Quiet room</span>
          <span>Noisy</span>
        </div>
      </div>

      {/* Minimum silence */}
      <div className="mb-3">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-content-faint">Min. silence</div>
        <div className="flex gap-1">
          {MIN_SILENCE_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ minSilenceSecs: s })}
              className={
                "flex-1 rounded-btn border px-2 py-1 text-xs tabular-nums transition-colors " +
                (settings.minSilenceSecs === s
                  ? "border-lime/40 bg-lime/10 text-lime"
                  : "border-white/10 text-content-secondary hover:bg-white/[0.05]")
              }
            >
              {s}s
            </button>
          ))}
        </div>
      </div>

      {/* Skip speed (smooth mode only; instant is fixed at the 4× ceiling) */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-content-faint">
          <span>Skip speed</span>
          {settings.mode === "instant" && <span className="text-content-faint">Instant uses 4×</span>}
        </div>
        <div className={"flex gap-1 " + (settings.mode === "instant" ? "pointer-events-none opacity-40" : "")}>
          {SKIP_SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ skipSpeed: s })}
              className={
                "flex-1 rounded-btn border px-2 py-1 text-xs tabular-nums transition-colors " +
                (settings.skipSpeed === s
                  ? "border-lime/40 bg-lime/10 text-lime"
                  : "border-white/10 text-content-secondary hover:bg-white/[0.05]")
              }
            >
              {formatRate(s)}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
