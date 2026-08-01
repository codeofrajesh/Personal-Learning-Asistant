/**
 * StudyMeter — today's real time on task, in the primary sidebar.
 *
 * ## Why a meter belongs here at all
 *
 * The sidebar is the one surface present on every route, including the player. That makes it the
 * only place a progress signal can be *ambient*: the student sees today's accumulated study while
 * they study, without navigating to the Dashboard to be told. The number is real minutes from
 * `study_sessions` (via `study_meter`), not planned minutes, so it can only go up by actually
 * doing the work.
 *
 * ## Two layouts, one component
 *
 * The sidebar collapses to a 96px rail, so this ships as two genuinely different compositions
 * rather than one that degrades:
 *
 *   * **expanded** — a wide glass card: the time as the headline, its goal underneath, a gradient
 *     track, and a caption naming where the goal came from.
 *   * **collapsed** — a 44px conic-gradient ring with the hour count inside it. The ring IS the
 *     information, so nothing has to be read at 96px wide, and the title/aria-label carry the full
 *     sentence for hover and screen readers.
 *
 * Both are the same DOM subtree so React swaps attributes rather than unmounting on `Ctrl+B`.
 *
 * ## The fill is CSS
 *
 * The track and the ring are a `linear-gradient` / `conic-gradient` driven by one custom property.
 * No JS animation, no canvas, no SVG library: it re-renders once a minute (see `useStudyMeter`) and
 * the compositor handles the transition. Same reasoning as the now-line in `TodayTab`.
 */

import { useMemo } from "react";
import { Flame } from "lucide-react";
import { useStudyMeter } from "./useStudyMeter";
import { cn } from "../../lib/utils";
import type { CSSProperties } from "react";

interface Props {
  collapsed: boolean;
}

/** `"1h 20m"` / `"45m"` — matches `planningUtils.fmtMins` so every surface reads identically. */
function fmtMins(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/**
 * Compact label for the collapsed ring: at most three characters, because the ring's inner
 * diameter is ~28px. It shows an HOUR COUNT — whole hours once past an hour ("2h"), minutes
 * below it, and a dash at zero — "0m" inside a glowing ring reads as broken rather than as
 * "not started". The full sentence ("1h 30m studied today…") lives in `title`/`aria-label`.
 *
 * The previous form rendered hours to one decimal (`h.toFixed(1)`), which produced trailing
 * zeros ("1.0h" for 61m, "3.0h" for 179m), four-to-five glyphs that overflowed the ring, and a
 * "10.0h" at the 9h59m boundary — where the `h < 10` gate contradicted the rounded value it
 * displayed. Whole-hour rounding keeps every label to three characters and never lies.
 */
function fmtTiny(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m <= 0) return "–";
  if (m < 60) return `${m}`;
  return `${Math.min(99, Math.round(m / 60))}h`;
}

export default function StudyMeter({ collapsed }: Props) {
  const meter = useStudyMeter();

  const view = useMemo(() => {
    const studied = meter?.studied_mins ?? 0;
    const goal = Math.max(1, meter?.goal_mins ?? 120);
    const ratio = Math.max(0, Math.min(1, studied / goal));
    const met = studied >= goal;

    // Colour carries the state, so the meter is readable at a glance without reading it:
    // lime once the goal is met, orange while there's real momentum, cyan at the start.
    // (Never red — an unfinished day is not a failure, and punishing a student mid-session is
    // the fastest way to have them close the app.)
    const tone = met
      ? { from: "#AAFF00", to: "#BEFF3D", text: "text-lime", ring: "border-lime/30" }
      : ratio >= 0.5
        ? { from: "#FF6B35", to: "#FF8659", text: "text-orange", ring: "border-orange/25" }
        : { from: "#22D3EE", to: "#38BDF8", text: "text-cyan-300", ring: "border-cyan-400/20" };

    const source =
      meter?.goal_source === "plan"
        ? "of today's plan"
        : meter?.goal_source === "setting"
          ? "of your daily goal"
          : "of a 2h default goal";

    return { studied, goal, ratio, met, tone, source };
  }, [meter]);

  // One custom property feeds both the bar and the ring; everything else is static CSS.
  const vars = {
    "--meter": `${view.ratio * 100}%`,
    "--meter-deg": `${view.ratio * 360}deg`,
    "--meter-from": view.tone.from,
    "--meter-to": view.tone.to,
  } as CSSProperties;

  const sentence =
    meter == null
      ? "Study time today"
      : `${fmtMins(view.studied)} studied today, ${Math.round(view.ratio * 100)}% ${view.source}` +
        (view.met ? " — goal met" : "");

  // ── Collapsed: the ring IS the readout ──
  if (collapsed) {
    return (
      <div
        className="mt-3 grid place-items-center"
        title={sentence}
        aria-label={sentence}
        role="img"
      >
        <div
          className="relative grid h-11 w-11 place-items-center rounded-full"
          style={{
            ...vars,
            // A conic gradient to the fill angle, with the remainder left as a faint track.
            background:
              "conic-gradient(from -90deg, var(--meter-from) 0deg, var(--meter-to) var(--meter-deg), rgba(255,255,255,0.07) var(--meter-deg))",
          }}
        >
          {/* Punches the centre out, turning the disc into a ring without an SVG. */}
          <span
            className="absolute inset-[3px] rounded-full bg-ink-900"
            aria-hidden
          />
          <span
            className={cn(
              "relative text-[0.66rem] font-semibold leading-none tabular-nums",
              view.tone.text,
            )}
          >
            {fmtTiny(view.studied)}
          </span>
        </div>
      </div>
    );
  }

  // ── Expanded: full glass card ──
  return (
    <div
      className={cn(
        "mt-3 rounded-[18px] border bg-white/[0.02] p-3 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] backdrop-blur-xl transition-colors",
        view.tone.ring,
      )}
      style={vars}
      aria-label={sentence}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Flame
            size={12}
            strokeWidth={2.5}
            className={cn("shrink-0", view.tone.text)}
            aria-hidden
          />
          <span className="text-[0.62rem] font-medium uppercase tracking-wide text-white/40">
            Studied today
          </span>
        </div>
        {view.met && (
          <span className="shrink-0 rounded-full border border-lime/25 bg-lime/10 px-1.5 py-0.5 text-[0.56rem] font-semibold text-lime">
            Goal
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-1.5">
        <span
          className={cn("text-xl font-semibold leading-none tabular-nums", view.tone.text)}
        >
          {fmtMins(view.studied)}
        </span>
        <span className="text-[0.66rem] text-white/35">/ {fmtMins(view.goal)}</span>
      </div>

      {/* The track. `--meter` is a hard colour stop, so there is no half-lit remainder to
          misread as progress. */}
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"
        role="progressbar"
        aria-valuenow={Math.round(view.ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progress toward today's study goal"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-smooth"
          style={{
            width: "var(--meter)",
            background: "linear-gradient(90deg, var(--meter-from), var(--meter-to))",
          }}
        />
      </div>

      <p className="mt-1.5 text-[0.6rem] leading-snug text-white/30">
        {Math.round(view.ratio * 100)}% {view.source}
      </p>
    </div>
  );
}
