/**
 * PeriodChart — the switchable Day / Week / Month breakdown, driven by the view toggle.
 *
 * Composited CSS bars (flex columns, height as a percentage) with solid X-axis baselines,
 * high-contrast date/weekday/hour labels, and executive StudyInsights cards.
 *
 *   • Day   — today vs yesterday + 24-hour timeline with clear 12 AM / 6 AM / 12 PM markers.
 *   • Week  — 7-day breakdown with full day names ("Thursday"), dates ("10 Sep"), and hours.
 *   • Month — 30-day timeline with solid baseline, periodic milestone date ticks, and peak indicator.
 */

import type { DayStudy } from "../../lib/types";
import { useScheduleClock, dayOffset } from "../../lib/scheduleClock";
import { currentTier } from "../../lib/perfStore";
import {
  fmtHM,
  fmtDateShort,
  weekdayShort,
  weekdayFull,
  isWeekend,
  fmtHour12,
  sumMins,
  peakDay,
  delta,
  performanceTone,
} from "./analyticsUtils";
import { cn } from "../../lib/utils";
import StudyInsights from "./StudyInsights";

export type Period = "day" | "week" | "month";

interface Props {
  daily: DayStudy[];
  hourlyToday?: number[];
  period: Period;
  targetMins: number | null;
  /** Active period selections for dynamic navigation */
  selectedDate?: string;
  selectedHourly?: number[];
  selectedWeekDays?: DayStudy[];
  prevWeekDays?: DayStudy[];
  selectedMonthDays?: DayStudy[];
  periodLabel?: string;
}

const PANEL = "flex h-full flex-col rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl gap-5";

/** Static bar glow, suppressed on lite (flat surfaces, zero extra compositing). */
function barGlow(color: string | null): string | undefined {
  if (!color || currentTier() === "lite") return undefined;
  return `0 0 10px -1px ${color}`;
}

export default function PeriodChart({
  daily,
  hourlyToday,
  period,
  targetMins,
  selectedDate,
  selectedHourly,
  selectedWeekDays,
  prevWeekDays,
  selectedMonthDays,
  periodLabel,
}: Props) {
  const target = targetMins ?? 0;
  return (
    <div className={PANEL}>
      <div className="flex-1 flex flex-col justify-between">
        {period === "day" && (
          <DayChart
            daily={daily}
            hourlyToday={selectedHourly ?? hourlyToday ?? []}
            selectedDate={selectedDate}
            target={target}
          />
        )}
        {period === "week" && (
          <WeekChart
            daily={daily}
            selectedWeekDays={selectedWeekDays}
            prevWeekDays={prevWeekDays}
            weekLabel={periodLabel}
            target={target}
          />
        )}
        {period === "month" && (
          <MonthChart
            daily={daily}
            selectedMonthDays={selectedMonthDays}
            monthLabel={periodLabel}
            target={target}
          />
        )}
      </div>

      {/* Derived executive study insights strip */}
      <div className="border-t border-white/[0.08] pt-4 mt-auto">
        <StudyInsights daily={daily} targetMins={targetMins} />
      </div>
    </div>
  );
}

// ── Month Chart ───────────────────────────────────────────────────────────────

function MonthChart({
  daily,
  selectedMonthDays,
  monthLabel,
  target,
}: {
  daily: DayStudy[];
  selectedMonthDays?: DayStudy[];
  monthLabel?: string;
  target: number;
}) {
  const today = useScheduleClock((s) => s.day);
  const days = selectedMonthDays ?? daily.slice(Math.max(0, daily.length - 30));
  const peak = peakDay(days);
  const total = sumMins(days);
  const scaleMax = Math.max(1, ...days.map((d) => d.work_mins), target);
  const targetPct = target > 0 ? Math.min(100, (target / scaleMax) * 100) : null;
  const title = monthLabel ?? "Last 30 days";

  return (
    <div className="flex h-full flex-col">
      <ChartHeader
        title={title}
        primary={fmtHM(total)}
        note={peak ? `Peak ${fmtHM(peak.work_mins)} · ${fmtDateShort(peak.date)}` : "No study logged yet"}
      />

      {/* Bars container */}
      <div className="relative mt-4 h-56 min-h-[200px] flex-1">
        {targetPct != null && (
          <div
            className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
            style={{ bottom: `${targetPct}%` }}
          >
            <div className="h-px flex-1 border-t border-dashed border-white/30" />
            <span className="ml-2 shrink-0 rounded-full bg-white/[0.08] px-2 py-0.5 text-[0.6rem] font-semibold text-white/70 border border-white/10">
              {fmtHM(target)}/day goal
            </span>
          </div>
        )}

        <div className="flex h-full items-end gap-[3px]">
          {days.map((d) => {
            const tone = performanceTone(d.work_mins, target);
            const pct = d.work_mins > 0 ? Math.max(4, (d.work_mins / scaleMax) * 100) : 0;
            const isPeak = peak != null && d.date === peak.date && d.work_mins > 0;
            const isCurrentDay = d.date === today;
            const weekend = isWeekend(d.date);

            return (
              <div
                key={d.date}
                className={cn(
                  "group relative flex flex-1 items-end rounded-t transition-colors",
                  weekend && "bg-white/[0.02]",
                )}
                style={{ height: "100%" }}
                title={`${fmtDateShort(d.date)} · ${fmtHM(d.work_mins)}${weekend ? " · weekend" : ""} · ${tone.label}`}
              >
                <div
                  className={cn(
                    "w-full rounded-t-[3px] transition-[height] duration-500",
                    isPeak && "outline outline-1 outline-white/50 shadow-sm",
                    isCurrentDay && "ring-1 ring-white/60",
                  )}
                  style={{ height: `${pct}%`, background: tone.bar, boxShadow: barGlow(tone.glow) }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Crisp Solid X-Axis Baseline */}
      <div className="mt-1 h-[2px] w-full rounded-full bg-white/[0.18]" />

      {/* High-Contrast Month Axis Row */}
      <MonthAxisRow days={days} today={today} />

      {/* Performance Legend */}
      <div className="mt-3">
        <PerfLegend weekend target={target > 0} />
      </div>
    </div>
  );
}

/** High-contrast X-axis row for Month view with aligned dates and tick markers. */
function MonthAxisRow({ days, today }: { days: DayStudy[]; today: string }) {
  if (!days.length) return null;

  // Select key milestone indices to label: day 1, multiples of 5, last day, and today
  const total = days.length;
  const labeledIndices = new Set<number>();
  labeledIndices.add(0);
  labeledIndices.add(total - 1);

  // Interval spacing based on total days (e.g. 5 days for 30d view)
  const step = total > 20 ? 5 : 3;
  for (let i = step - 1; i < total - 1; i += step) {
    // Avoid crowding the last day
    if (total - 1 - i >= 2) labeledIndices.add(i);
  }

  // Ensure today is highlighted if present
  const todayIdx = days.findIndex((d) => d.date === today);
  if (todayIdx !== -1) labeledIndices.add(todayIdx);

  return (
    <div className="mt-1 flex gap-[3px]">
      {days.map((d, i) => {
        const isLabeled = labeledIndices.has(i);
        const isCurrent = d.date === today;

        return (
          <div key={d.date} className="flex flex-1 flex-col items-center min-w-0">
            {/* Tick marker */}
            <div
              className={cn(
                "rounded-full transition-colors",
                isLabeled ? "h-1.5 w-[2px] bg-white/50" : "h-1 w-px bg-white/15",
                isCurrent && "bg-lime w-[2px] h-2",
              )}
            />

            {/* Label */}
            {isLabeled ? (
              <span
                className={cn(
                  "mt-1 whitespace-nowrap text-[0.68rem] font-semibold tabular-nums",
                  isCurrent ? "text-lime font-bold" : "text-white/80",
                )}
              >
                {fmtDateShort(d.date)}
              </span>
            ) : (
              <div className="h-4" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Week Chart ────────────────────────────────────────────────────────────────

function WeekChart({
  daily,
  selectedWeekDays,
  prevWeekDays,
  weekLabel,
  target,
}: {
  daily: DayStudy[];
  selectedWeekDays?: DayStudy[];
  prevWeekDays?: DayStudy[];
  weekLabel?: string;
  target: number;
}) {
  const today = useScheduleClock((s) => s.day);
  const n = daily.length;
  const thisWeek = selectedWeekDays ?? daily.slice(Math.max(0, n - 7));
  const lastWeek = prevWeekDays ?? daily.slice(Math.max(0, n - 14), Math.max(0, n - 7));
  const thisTotal = sumMins(thisWeek);
  const lastTotal = sumMins(lastWeek);
  const d = delta(thisTotal, lastTotal);
  const scaleMax = Math.max(1, ...thisWeek.map((x) => x.work_mins), ...lastWeek.map((x) => x.work_mins), target);
  const title = weekLabel ? `Week: ${weekLabel}` : "This week vs last";

  return (
    <div className="flex h-full flex-col">
      <ChartHeader
        title={title}
        primary={fmtHM(thisTotal)}
        note={
          d.isNew
            ? "First week of data"
            : d.pct == null
              ? `Last week ${fmtHM(lastTotal)}`
              : `${d.up ? "+" : ""}${d.pct}% vs last week (${fmtHM(lastTotal)})`
        }
        noteTone={d.pct == null ? "muted" : d.up ? "up" : "down"}
      />

      {/* 7-Day Bars */}
      <div className="mt-4 flex h-56 min-h-[200px] flex-1 items-end gap-3">
        {thisWeek.map((cur, i) => {
          const prev = lastWeek[i];
          const tone = performanceTone(cur.work_mins, target);
          const curPct = cur.work_mins > 0 ? Math.max(4, (cur.work_mins / scaleMax) * 100) : 0;
          const prevPct = prev && prev.work_mins > 0 ? Math.max(3, (prev.work_mins / scaleMax) * 100) : 0;
          const isCurrentDay = cur.date === today;

          return (
            <div key={cur.date} className="flex h-full flex-1 flex-col items-center">
              <div className="relative flex w-full flex-1 items-end justify-center">
                {prev && (
                  <div
                    className="absolute bottom-0 w-[72%] rounded-t-[4px] bg-white/[0.08]"
                    style={{ height: `${prevPct}%` }}
                    title={`${fmtDateShort(prev.date)} (last week) · ${fmtHM(prev.work_mins)}`}
                  />
                )}
                <div
                  className={cn(
                    "relative w-[62%] rounded-t-[4px] transition-[height] duration-500",
                    isCurrentDay && "ring-1 ring-white/60",
                  )}
                  style={{ height: `${curPct}%`, background: tone.bar, boxShadow: barGlow(tone.glow) }}
                  title={`${fmtDateShort(cur.date)} · ${fmtHM(cur.work_mins)} · ${tone.label}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Crisp Solid X-Axis Baseline */}
      <div className="mt-1 h-[2px] w-full rounded-full bg-white/[0.18]" />

      {/* Prominent High-Contrast Weekday + Date Labels */}
      <div className="mt-2.5 flex gap-3">
        {thisWeek.map((cur) => {
          const isCurrentDay = cur.date === today;
          const weekend = isWeekend(cur.date);

          return (
            <div key={cur.date} className="flex flex-1 flex-col items-center min-w-0">
              {/* Full or Short Day Name */}
              <span
                className={cn(
                  "text-[0.74rem] font-bold tracking-tight",
                  isCurrentDay ? "text-lime" : weekend ? "text-white/60" : "text-white/90",
                )}
              >
                <span className="hidden sm:inline">{weekdayFull(cur.date)}</span>
                <span className="sm:hidden">{weekdayShort(cur.date)}</span>
              </span>

              {/* Exact Date: e.g. "10 Sep" */}
              <span
                className={cn(
                  "mt-0.5 text-[0.7rem] font-semibold tabular-nums",
                  isCurrentDay ? "text-lime font-bold" : "text-white/70",
                )}
              >
                {fmtDateShort(cur.date)}
              </span>

              {/* Study Time Tag */}
              <span
                className={cn(
                  "mt-1.5 rounded px-1.5 py-0.5 text-[0.66rem] font-semibold tabular-nums",
                  cur.work_mins > 0 ? "bg-white/[0.06] text-white/85" : "text-white/30",
                )}
              >
                {cur.work_mins > 0 ? fmtHM(cur.work_mins) : "Rest"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-3">
        <PerfLegend target={target > 0} lastWeek />
      </div>
    </div>
  );
}

// ── Day Chart ─────────────────────────────────────────────────────────────────

function DayChart({
  daily,
  hourlyToday,
  selectedDate,
  target,
}: {
  daily: DayStudy[];
  hourlyToday: number[];
  selectedDate?: string;
  target: number;
}) {
  const clockDay = useScheduleClock((s) => s.day);
  const nowMins = useScheduleClock((s) => s.minutes);
  const currentHour = Math.floor(nowMins / 60);

  const activeDay = selectedDate ?? clockDay;
  const isToday = activeDay === clockDay;

  const byDate = new Map(daily.map((d) => [d.date, d]));
  const today = byDate.get(activeDay) ?? { date: activeDay, work_mins: 0 };
  const prevDate = dayOffset(activeDay, -1);
  const yesterday = byDate.get(prevDate) ?? { date: prevDate, work_mins: 0 };

  const todayMins = today.work_mins;
  const yMins = yesterday.work_mins;
  const d = delta(todayMins, yMins);
  const tone = performanceTone(todayMins, target);
  const hours = hourlyToday.length === 24 ? hourlyToday : new Array(24).fill(0);
  const scaleMax = Math.max(1, ...hours);

  return (
    <div className="flex h-full flex-col">
      {/* Top Cards: Today vs Yesterday */}
      <div className="grid grid-cols-2 gap-3">
        <div className={cn("rounded-[14px] border p-3.5", tone.chip)}>
          <div className="text-[0.65rem] font-semibold uppercase tracking-wider opacity-75">
            {isToday ? "Today" : fmtDateShort(activeDay)}
          </div>
          <div className={cn("mt-1 text-2xl font-black tabular-nums", tone.text)}>{fmtHM(todayMins)}</div>
          <div className="mt-0.5 text-[0.7rem] font-medium opacity-85">{tone.label}</div>
        </div>

        <div className="rounded-[14px] border border-white/[0.08] bg-white/[0.025] p-3.5">
          <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-white/50">
            {isToday ? "Yesterday" : fmtDateShort(prevDate)}
          </div>
          <div className="mt-1 text-2xl font-black tabular-nums text-content-secondary">{fmtHM(yMins)}</div>
          <div className="mt-0.5 text-[0.7rem] text-white/45">
            {d.isNew ? "your first day" : d.pct == null ? "—" : `${d.up ? "+" : ""}${d.pct}% vs prior day`}
          </div>
        </div>
      </div>

      {/* 24-Hour Timeline Section */}
      <div className="mt-5 flex-1 flex flex-col justify-end">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[0.68rem] font-semibold uppercase tracking-wider text-white/50">
            {isToday ? "24-Hour Study Timeline (Today)" : `24-Hour Timeline · ${fmtDateShort(activeDay)}`}
          </span>
          {isToday && (
            <span className="flex items-center gap-1.5 text-[0.66rem] font-medium text-lime">
              <span className="h-1.5 w-1.5 rounded-full bg-lime animate-pulse" />
              Live {fmtHour12(currentHour)}
            </span>
          )}
        </div>

        {/* 24 Hourly Bars */}
        <div className="flex h-36 min-h-[120px] items-end gap-[3px]">
          {hours.map((mins, h) => {
            const pct = mins > 0 ? Math.max(6, (mins / scaleMax) * 100) : 0;
            const isNow = h === currentHour && isToday;

            return (
              <div
                key={h}
                className="relative flex flex-1 items-end"
                style={{ height: "100%" }}
                title={`${fmtHour12(h)} · ${fmtHM(mins)}`}
              >
                <div
                  className={cn("w-full rounded-t-[3px] transition-[height] duration-500")}
                  style={{
                    height: `${pct}%`,
                    background: mins > 0 ? tone.bar : "transparent",
                    boxShadow: isNow ? barGlow(tone.glow ?? tone.solid) : undefined,
                    outline: isNow && mins === 0 ? `1px dashed ${tone.solid}` : undefined,
                    minHeight: isNow && mins === 0 ? "6px" : undefined,
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Crisp Solid X-Axis Baseline */}
        <div className="mt-1 h-[2px] w-full rounded-full bg-white/[0.18]" />

        {/* High-Contrast Hourly X-Axis Labels & Ticks */}
        <DayHourAxis currentHour={isToday ? currentHour : -1} />
      </div>
    </div>
  );
}

/** High-contrast 24-hour axis with clear AM/PM markers and tick lines. */
function DayHourAxis({ currentHour }: { currentHour: number }) {
  // Labeled hours: 12a, 4a, 8a, 12p, 4p, 8p, 11p (or 3-hour milestones)
  const labeledHours = new Set([0, 4, 8, 12, 16, 20, 23]);

  return (
    <div className="mt-1 flex gap-[3px]">
      {Array.from({ length: 24 }, (_, h) => {
        const isLabeled = labeledHours.has(h);
        const isCurrent = h === currentHour;

        return (
          <div key={h} className="flex flex-1 flex-col items-center min-w-0">
            {/* Tick mark */}
            <div
              className={cn(
                "rounded-full transition-colors",
                isLabeled ? "h-1.5 w-[2px] bg-white/50" : "h-1 w-px bg-white/15",
                isCurrent && "bg-lime w-[2px] h-2",
              )}
            />

            {/* Label */}
            {isLabeled ? (
              <span
                className={cn(
                  "mt-1 whitespace-nowrap text-[0.68rem] font-semibold tabular-nums",
                  isCurrent ? "text-lime font-bold" : "text-white/75",
                )}
              >
                {fmtHour12(h)}
              </span>
            ) : (
              <div className="h-4" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Shared Header & Legend ────────────────────────────────────────────────────

function ChartHeader({
  title,
  primary,
  note,
  noteTone = "muted",
}: {
  title: string;
  primary: string;
  note: string;
  noteTone?: "muted" | "up" | "down";
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-white/50">{title}</div>
        <div className="mt-0.5 text-2xl font-black tabular-nums text-content-primary">{primary}</div>
      </div>
      <span
        className={cn(
          "text-[0.74rem] font-semibold tabular-nums",
          noteTone === "up" ? "text-emerald-400" : noteTone === "down" ? "text-red-400" : "text-white/50",
        )}
      >
        {note}
      </span>
    </div>
  );
}

/** The performance-color key (+ optional weekend / last-week / target markers). */
function PerfLegend({
  target,
  weekend = false,
  lastWeek = false,
}: {
  target: boolean;
  weekend?: boolean;
  lastWeek?: boolean;
}) {
  const items: { color: string; label: string }[] = [
    { color: "#EF4444", label: "Below Target" },
    { color: "#2563EB", label: "Target Met" },
    { color: "#F97316", label: "Target Exceeded" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.72rem] font-medium text-white/60">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: it.color }} aria-hidden />
          {it.label}
        </span>
      ))}
      {lastWeek && (
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-white/[0.14]" aria-hidden />
          Last Week
        </span>
      )}
      {weekend && (
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-white/[0.04] border border-white/10" aria-hidden />
          Weekend
        </span>
      )}
      {target && <span className="text-white/50">╌ Target Goal</span>}
    </div>
  );
}
