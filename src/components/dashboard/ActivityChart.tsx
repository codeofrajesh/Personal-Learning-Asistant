/**
 * Activity chart — the right-hand widget from `dashboard Designs/image 3 fav.png`:
 * a big "Hours spend" headline, a "last 7 days" pill, and a row of thick rounded-pill
 * bars where the peak day glows bright (with a floating value chip) and the rest stay
 * muted white/10. Weekday labels beneath.
 *
 * Honest data (app rule): bars scale to real `ActivityDay.hours` from the DB; a fresh
 * install shows flat minimal stubs + a quiet "no study time logged yet" note.
 *
 * Hand-rolled CSS bars (no chart lib — bundle/memory target). Bright peak uses white
 * for the glow "spotlight" look of the reference, keeping lime/cyan for the rest.
 */

import { memo } from "react";
import { CalendarDays } from "lucide-react";
import type { ActivityDay } from "../../lib/types";

const DAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return DAY_LABEL[d.getDay()] ?? "";
}

function ActivityChartView({ activity }: { activity: ActivityDay[] }) {
  const max = Math.max(0, ...activity.map((a) => a.hours));
  const totalHours = activity.reduce((sum, a) => sum + a.hours, 0);
  const hasData = totalHours > 0;
  const peakIndex = hasData ? activity.findIndex((a) => a.hours === max) : -1;

  return (
    <section className="activity-chart relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-content-primary">Activity</h2>
        <span className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[0.7rem] font-medium text-white/60">
          <CalendarDays size={13} strokeWidth={2} aria-hidden />
          last 7 days
        </span>
      </header>

      {/* Headline hours */}
      <div className="mt-3 flex items-end gap-2">
        <span className="text-4xl font-bold leading-none tracking-tight text-content-primary tabular-nums">
          {totalHours.toFixed(1)}
        </span>
        <span className="mb-1 text-xs leading-tight text-white/40">
          Hours
          <br />
          spend
        </span>
      </div>

      {/* Bars */}
      <div className="mt-6 flex flex-1 items-end justify-between gap-2" aria-hidden="true">
        {activity.map((a, i) => {
          const heightPct = max > 0 ? Math.max(6, (a.hours / max) * 100) : 6;
          const isPeak = i === peakIndex;
          return (
            <div key={a.date} className="flex flex-1 flex-col items-center gap-2.5">
              <div className="relative flex h-32 w-full items-end justify-center">
                {isPeak && a.hours > 0 && (
                  <span className="absolute -top-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-cyan-400 px-2 py-0.5 text-[0.6rem] font-bold text-ink-900 shadow-[0_0_12px_rgba(34,211,238,0.6)]">
                    {a.hours.toFixed(1)}h
                  </span>
                )}
                <div
                  className={
                    "w-full max-w-[1.6rem] rounded-full transition-[height] duration-500 ease-smooth " +
                    (isPeak
                      ? "bg-gradient-to-t from-white/80 to-white shadow-[0_0_20px_rgba(255,255,255,0.45)]"
                      : "bg-white/10")
                  }
                  style={{ height: `${heightPct}%` }}
                  title={`${dayLabel(a.date)}: ${a.hours.toFixed(1)} h`}
                />
              </div>
              <span
                className={
                  "text-[0.68rem] " + (isPeak ? "font-semibold text-content-primary" : "text-white/40")
                }
              >
                {dayLabel(a.date)}
              </span>
            </div>
          );
        })}
      </div>

      {!hasData && (
        <p className="mt-3 text-center text-[0.7rem] text-white/30">
          No study time logged yet — it appears here once you start watching.
        </p>
      )}
    </section>
  );
}

export default memo(ActivityChartView);
