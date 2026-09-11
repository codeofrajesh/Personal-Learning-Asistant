/**
 * PeakHoursPanel — the student's chronotype, learned from logged sessions.
 *
 * Reuses the existing `usePeakHours` hook (UNCHANGED — the same one the Planning Review tab uses),
 * then derives two actionable things from its `hours` array: the "golden window" (the contiguous
 * run around the peak) and a Morning/Afternoon/Evening/Night split. Honors the hook's confidence
 * gate so a couple of sessions don't masquerade as a habit.
 */

import { Sparkles, Sunrise, Sun, Sunset, Moon } from "lucide-react";
import { usePeakHours } from "../planning/usePeakHours";
import {
  chronotype,
  goldenWindow,
  goldenWindowFromHourly,
  chronotypeFromHourly,
  fmtHour12,
  fmtHM,
} from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  hourly?: number[];
  periodLabel?: string;
}

const PANEL = "h-full rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl";

const CHRONO_ICON: Record<string, typeof Sun> = {
  morning: Sunrise,
  afternoon: Sun,
  evening: Sunset,
  night: Moon,
};

export default function PeakHoursPanel({ hourly, periodLabel }: Props) {
  const hookData = usePeakHours(60);

  // If period-specific hourly distribution is provided and has data, use it.
  const hasPeriodHourly = hourly && hourly.length === 24 && hourly.some((m) => m > 0);

  const golden = hasPeriodHourly
    ? goldenWindowFromHourly(hourly)
    : goldenWindow(hookData.hours);

  const { buckets } = hasPeriodHourly
    ? chronotypeFromHourly(hourly)
    : chronotype(hookData.hours);

  const totalMins = hasPeriodHourly
    ? hourly.reduce((a, b) => a + b, 0)
    : hookData.totalMins;

  const confident = hasPeriodHourly ? totalMins > 0 : hookData.confident;
  const loaded = hasPeriodHourly ? true : hookData.loaded;

  const titleText = periodLabel
    ? `Peak focus hours · ${periodLabel}`
    : "Peak focus hours · 60 days";

  return (
    <div className={PANEL} style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}>
      <div className="mb-3 flex items-center gap-1.5 text-[0.62rem] font-medium uppercase tracking-wide text-white/40">
        <Sparkles size={13} strokeWidth={2.25} className="shrink-0 text-lime" aria-hidden />
        {titleText}
      </div>

      {!confident ? (
        <div className="grid min-h-[120px] place-items-center rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-4 text-center">
          <div>
            <p className="text-sm text-white/50">
              {loaded ? "Not enough data yet to spot your rhythm." : "Reading your sessions…"}
            </p>
            <p className="mt-1 text-[0.7rem] text-white/30">
              {fmtHM(totalMins)} logged so far · keep studying and your golden hours will appear.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Golden window */}
          {golden && (
            <div className="mb-4 rounded-[14px] border border-lime/20 bg-lime/[0.05] p-3">
              <div className="text-[0.6rem] font-medium uppercase tracking-wide text-lime/70">
                Golden window
              </div>
              <div className="mt-1 text-lg font-bold tabular-nums text-lime">
                {fmtHour12(golden.startHour)} – {fmtHour12(golden.endHour + 1)}
              </div>
              <p className="mt-0.5 text-[0.72rem] leading-snug text-white/45">
                {golden.pct}% of your deep focus happens here. Defend it — schedule your hardest work
                in this window.
              </p>
            </div>
          )}

          {/* Time-of-day breakdown */}
          <div className="space-y-2.5">
            {buckets.map((b) => {
              const Icon = CHRONO_ICON[b.key] ?? Sun;
              return (
                <div key={b.key} className="flex items-center gap-3">
                  <span className="flex w-24 shrink-0 items-center gap-1.5 text-[0.72rem] text-white/55">
                    <Icon size={13} strokeWidth={2} className="shrink-0 text-white/40" aria-hidden />
                    {b.label}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className={cn("h-full rounded-full transition-[width] duration-500")}
                      style={{
                        width: `${b.pct}%`,
                        background: "linear-gradient(90deg, #6FAF00, #AAFF00)",
                      }}
                    />
                  </div>
                  <span className="w-9 shrink-0 text-right text-[0.7rem] font-semibold tabular-nums text-white/45">
                    {b.pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
