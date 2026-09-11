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
 *     track, and a caption naming where the goal came from. Once the goal is met the caption keeps
 *     counting — "131% … +37m over" — instead of freezing at 100%.
 *   * **collapsed** — a 44px conic-gradient ring with the hour count inside it. The ring IS the
 *     information, so nothing has to be read at 96px wide, and the title/aria-label carry the full
 *     sentence (including any overtime) for hover and screen readers.
 *
 * Both are the same DOM subtree so React swaps attributes rather than unmounting on `Ctrl+B`.
 *
 * ## Geometry is capped; the readout is not
 *
 * The headline and caption show the FULL time studied and can run past the goal — that real total,
 * uncapped, is the whole reason the meter exists. But two quantities are kept deliberately apart:
 *
 *   * `fill` (0–1) drives geometry only — the bar's width, the ring's sweep, and `aria-valuenow`.
 *     A bar cannot be more than full, and a progressbar with `aria-valuemax=100` must not report
 *     131, so this is clamped.
 *   * `pct` / `over` are the honest, UNCAPPED readout the student came to see. Collapsing these two
 *     into one clamped `ratio` was the old bug: everything downstream froze at "100% of a 2h goal".
 *
 * ## The fill is CSS
 *
 * The track and the ring are a `linear-gradient` / `conic-gradient` driven by one custom property.
 * No JS animation, no canvas, no SVG library: it re-renders once a minute (see `useStudyMeter`) and
 * the compositor handles the transition. The goal-met glow is a one-shot CSS transition into a
 * static box-shadow — no looping keyframes — so it never spins the compositor behind the player.
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
 * displayed. Whole-hour rounding keeps every label to three characters and never lies, and the
 * `min(99, …)` guard means even a marathon past-goal day ("99h") still fits three glyphs.
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

    // Two quantities, deliberately kept apart (see the file header):
    //   fill — geometry only, clamped to [0,1] so the bar/ring can't overrun and the
    //          progressbar never reports a value above its own max.
    //   pct / over — the honest, UNCAPPED readout: the real percentage and the surplus minutes
    //          past the goal. These are what used to freeze at 100%.
    const fill = Math.max(0, Math.min(1, studied / goal));
    const pct = Math.round((studied / goal) * 100);
    const met = studied >= goal;
    const over = Math.max(0, studied - goal);

    // Colour carries the state, so the meter is readable at a glance without reading it:
    // lime once the goal is met, orange while there's real momentum, cyan at the start.
    // (Never red — an unfinished day is not a failure, and punishing a student mid-session is
    // the fastest way to have them close the app.) `glow` lights the met state and is null
    // otherwise, so only crossing the goal earns the reward.
    const tone = met
      ? {
          from: "#10B981",
          to: "#059669",
          text: "text-emerald-400",
          ring: "border-emerald-500/30",
          glow: null as string | null,
        }
      : fill >= 0.5
        ? {
            from: "#2563EB",
            to: "#1D4ED8",
            text: "text-blue-300",
            ring: "border-blue-400/25",
            glow: null as string | null,
          }
        : {
            from: "#EF4444",
            to: "#DC2626",
            text: "text-red-400",
            ring: "border-red-500/25",
            glow: null as string | null,
          };

    const source =
      meter?.goal_source === "plan"
        ? "of today's plan"
        : meter?.goal_source === "setting"
          ? "of your daily goal"
          : "of a 2h default goal";

    return { studied, goal, fill, pct, met, over, tone, source };
  }, [meter]);

  // One custom property feeds both the bar and the ring; everything else is static CSS.
  const vars = {
    "--meter": `${view.fill * 100}%`,
    "--meter-deg": `${view.fill * 360}deg`,
    "--meter-from": view.tone.from,
    "--meter-to": view.tone.to,
  } as CSSProperties;

  // The uncapped percentage and surplus ride in the label too, so a screen-reader user hears the
  // overtime the sighted caption shows rather than a value frozen at "100%".
  const sentence =
    meter == null
      ? "Study time today"
      : `${fmtMins(view.studied)} studied today, ${view.pct}% ${view.source}` +
        (view.met ? ` — goal met, +${fmtMins(view.over)} past` : "");

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
          className="relative grid h-11 w-11 place-items-center rounded-full transition-[box-shadow] duration-500"
          style={{
            ...vars,
            // A conic gradient to the fill angle, with the remainder left as a faint track.
            background:
              "conic-gradient(from -90deg, var(--meter-from) 0deg, var(--meter-to) var(--meter-deg), rgba(255,255,255,0.07) var(--meter-deg))",
            // Own-element shadow, so it escapes the ring's rounded box and is not clipped.
            boxShadow: view.tone.glow ? `0 0 10px ${view.tone.glow}` : undefined,
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
        "mt-3 rounded-[18px] border bg-white/[0.02] p-3 backdrop-blur-xl transition-[border-color,box-shadow] duration-500",
        view.tone.ring,
      )}
      style={{
        ...vars,
        // Keep the inset top highlight in both states; add a soft outer bloom once the goal is met
        // so crossing the line lights the whole card, not just the bar. One-shot, no keyframes.
        boxShadow: view.met
          ? `inset 0 1px 1px rgba(255,255,255,0.05), 0 0 22px -10px ${view.tone.glow}`
          : "inset 0 1px 1px rgba(255,255,255,0.05)",
      }}
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
          <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[0.56rem] font-semibold text-emerald-400 shadow-[0_0_10px_-2px_rgba(16,185,129,0.5)]">
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
          misread as progress. The met glow lives on the track (its own outset shadow escapes the
          `overflow-hidden` that clips the fill), and eases in via `transition-shadow`. */}
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07] transition-shadow duration-500"
        style={{
          boxShadow: view.met
            ? `inset 0 0 0 1px rgba(255,255,255,0.04), 0 0 12px -2px ${view.tone.glow}`
            : "inset 0 0 0 1px rgba(255,255,255,0.04)",
        }}
        role="progressbar"
        aria-valuenow={Math.round(view.fill * 100)}
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

      {/* Uncapped caption: climbs past 100% and names the surplus, instead of freezing. */}
      <p className="mt-1.5 text-[0.6rem] leading-snug text-white/30">
        {view.pct}% {view.source}
        {view.met && view.over >= 1 && (
          <>
            {" · "}
            <span className="font-medium text-emerald-400">+{fmtMins(view.over)} over</span>
          </>
        )}
      </p>
    </div>
  );
}
