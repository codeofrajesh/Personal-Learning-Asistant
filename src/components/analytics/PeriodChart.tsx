/**
 * PeriodChart — the switchable Day / Week / Month breakdown, driven by the view toggle.
 *
 * Composited CSS bars (flex columns, height as a percentage) — no canvas, no chart library. Bars
 * are colored by the dynamic performance system (`performanceTone`): red below target, electric
 * cyan at target, emerald+gold over target. Glows are static box-shadows, gated OFF on the `lite`
 * perf tier so weak GPUs stay flat and cheap behind the 60fps player.
 *
 *   • Day   — today vs yesterday + a 24-hour timeline (toned by today's performance).
 *   • Week  — last 7 days vs the previous 7 (a faint "last week" bar behind each day).
 *   • Month — the last 30 days, weekends recessed, the peak day ringed, a dashed target line.
 */

import type { DayStudy } from "../../lib/types";
import { useScheduleClock } from "../../lib/scheduleClock";
import { currentTier } from "../../lib/perfStore";
import {
  fmtHM,
  fmtDateShort,
  weekdayShort,
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
  hourlyToday: number[];
  period: Period;
  targetMins: number | null;
}

const PANEL = "flex h-full flex-col justify-between rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl";

/** Static bar glow, suppressed on lite (flat surfaces, zero extra compositing). */
function barGlow(color: string | null): string | undefined {
  if (!color || currentTier() === "lite") return undefined;
  return `0 0 10px -1px ${color}`;
}

export default function PeriodChart({ daily, hourlyToday, period, targetMins }: Props) {
  const target = targetMins ?? 0;
  return (
    <div className={PANEL}>
      <div className="flex-1">
        {period === "day" && <DayChart daily={daily} hourlyToday={hourlyToday} target={target} />}
        {period === "week" && <WeekChart daily={daily} target={target} />}
        {period === "month" && <MonthChart daily={daily} target={target} />}
      </div>

      {/* Derived study insights placed inside the card below the chart */}
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <StudyInsights daily={daily} targetMins={targetMins} />
      </div>
    </div>
  );
}

// ── Month ─────────────────────────────────────────────────────────────────────

function MonthChart({ daily, target }: { daily: DayStudy[]; target: number }) {
  const days = daily.slice(Math.max(0, daily.length - 30));
  const peak = peakDay(days);
  const total = sumMins(days);
  const scaleMax = Math.max(1, ...days.map((d) => d.work_mins), target);
  const targetPct = target > 0 ? Math.min(100, (target / scaleMax) * 100) : null;

  return (
    <div className="flex h-full flex-col">
      <ChartHeader
        title="Last 30 days"
        primary={fmtHM(total)}
        note={peak ? `Peak ${fmtHM(peak.work_mins)} · ${fmtDateShort(peak.date)}` : "No study logged yet"}
      />
      <div className="relative mt-4 h-44">
        {targetPct != null && (
          <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ bottom: `${targetPct}%` }}>
            <div className="h-px flex-1 border-t border-dashed border-white/25" />
            <span className="ml-2 shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[0.55rem] font-semibold text-white/50">
              {fmtHM(target)}/day
            </span>
          </div>
        )}
        <div className="flex h-full items-end gap-[3px]">
          {days.map((d) => {
            const tone = performanceTone(d.work_mins, target);
            const pct = d.work_mins > 0 ? Math.max(4, (d.work_mins / scaleMax) * 100) : 0;
            const isPeak = peak != null && d.date === peak.date && d.work_mins > 0;
            const weekend = isWeekend(d.date);
            return (
              <div
                key={d.date}
                className={cn("group relative flex flex-1 items-end rounded-t", weekend && "bg-white/[0.02]")}
                style={{ height: "100%" }}
                title={`${fmtDateShort(d.date)} · ${fmtHM(d.work_mins)}${weekend ? " · weekend" : ""} · ${tone.label}`}
              >
                <div
                  className={cn("w-full rounded-t-[3px] transition-[height] duration-500", isPeak && "outline outline-1 outline-white/40")}
                  style={{ height: `${pct}%`, background: tone.bar, boxShadow: barGlow(tone.glow) }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <AxisRow labels={monthAxis(days)} />
      <PerfLegend weekend target={target > 0} />
    </div>
  );
}

function monthAxis(days: DayStudy[]): string[] {
  if (!days.length) return [];
  const out: string[] = new Array(days.length).fill("");
  for (let i = 0; i < days.length; i += 7) out[i] = fmtDateShort(days[i].date);
  out[days.length - 1] = fmtDateShort(days[days.length - 1].date);
  return out;
}

// ── Week ──────────────────────────────────────────────────────────────────────

function WeekChart({ daily, target }: { daily: DayStudy[]; target: number }) {
  const n = daily.length;
  const thisWeek = daily.slice(Math.max(0, n - 7));
  const lastWeek = daily.slice(Math.max(0, n - 14), Math.max(0, n - 7));
  const thisTotal = sumMins(thisWeek);
  const lastTotal = sumMins(lastWeek);
  const d = delta(thisTotal, lastTotal);
  const scaleMax = Math.max(1, ...thisWeek.map((x) => x.work_mins), ...lastWeek.map((x) => x.work_mins), target);

  return (
    <div className="flex h-full flex-col">
      <ChartHeader
        title="This week vs last"
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
      <div className="mt-4 flex h-44 items-end gap-2">
        {thisWeek.map((cur, i) => {
          const prev = lastWeek[i];
          const tone = performanceTone(cur.work_mins, target);
          const curPct = cur.work_mins > 0 ? Math.max(4, (cur.work_mins / scaleMax) * 100) : 0;
          const prevPct = prev && prev.work_mins > 0 ? Math.max(3, (prev.work_mins / scaleMax) * 100) : 0;
          return (
            <div key={cur.date} className="flex h-full flex-1 flex-col items-center gap-1">
              <div className="relative flex w-full flex-1 items-end justify-center">
                {prev && (
                  <div
                    className="absolute bottom-0 w-full rounded-t-[4px] bg-white/[0.06]"
                    style={{ height: `${prevPct}%` }}
                    title={`${fmtDateShort(prev.date)} (last week) · ${fmtHM(prev.work_mins)}`}
                  />
                )}
                <div
                  className="relative w-[62%] rounded-t-[4px] transition-[height] duration-500"
                  style={{ height: `${curPct}%`, background: tone.bar, boxShadow: barGlow(tone.glow) }}
                  title={`${fmtDateShort(cur.date)} · ${fmtHM(cur.work_mins)} · ${tone.label}`}
                />
              </div>
              <span className="text-[0.6rem] text-white/35">{weekdayShort(cur.date)}</span>
            </div>
          );
        })}
      </div>
      <PerfLegend target={target > 0} lastWeek />
    </div>
  );
}

// ── Day ─────────────────────────────────────────────────────────────────────

function DayChart({ daily, hourlyToday, target }: { daily: DayStudy[]; hourlyToday: number[]; target: number }) {
  const nowMins = useScheduleClock((s) => s.minutes);
  const currentHour = Math.floor(nowMins / 60);
  const n = daily.length;
  const today = daily[n - 1];
  const yesterday = daily[n - 2];
  const todayMins = today?.work_mins ?? 0;
  const yMins = yesterday?.work_mins ?? 0;
  const d = delta(todayMins, yMins);
  const tone = performanceTone(todayMins, target);
  const hours = hourlyToday.length === 24 ? hourlyToday : new Array(24).fill(0);
  const scaleMax = Math.max(1, ...hours);

  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-2 gap-3">
        <div className={cn("rounded-[14px] border p-3", tone.chip)}>
          <div className="text-[0.6rem] font-medium uppercase tracking-wide opacity-70">Today</div>
          <div className={cn("mt-1 text-2xl font-bold tabular-nums", tone.text)}>{fmtHM(todayMins)}</div>
          <div className="mt-0.5 text-[0.66rem] opacity-80">{tone.label}</div>
        </div>
        <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="text-[0.6rem] font-medium uppercase tracking-wide text-white/40">Yesterday</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-content-secondary">{fmtHM(yMins)}</div>
          <div className="mt-0.5 text-[0.66rem] text-white/35">
            {d.isNew ? "your first day" : d.pct == null ? "—" : `${d.up ? "+" : ""}${d.pct}% today`}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[0.62rem] font-medium uppercase tracking-wide text-white/40">
          When you studied today
        </div>
        <div className="flex h-28 items-end gap-[2px]">
          {hours.map((mins, h) => {
            const pct = mins > 0 ? Math.max(6, (mins / scaleMax) * 100) : 0;
            const isNow = h === currentHour;
            return (
              <div key={h} className="relative flex flex-1 items-end" style={{ height: "100%" }} title={`${fmtHour12(h)} · ${fmtHM(mins)}`}>
                <div
                  className={cn("w-full rounded-t-[2px] transition-[height] duration-500")}
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
        <AxisRow labels={hourAxis()} />
      </div>
    </div>
  );
}

function hourAxis(): string[] {
  const out = new Array(24).fill("");
  out[0] = "12a";
  out[6] = "6a";
  out[12] = "12p";
  out[18] = "6p";
  return out;
}

// ── Shared bits ─────────────────────────────────────────────────────────────

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
        <div className="text-[0.62rem] font-medium uppercase tracking-wide text-white/40">{title}</div>
        <div className="mt-0.5 text-xl font-bold tabular-nums text-content-primary">{primary}</div>
      </div>
      <span
        className={cn(
          "text-[0.72rem] font-medium",
          noteTone === "up" ? "text-[#34D399]" : noteTone === "down" ? "text-red-400" : "text-white/35",
        )}
      >
        {note}
      </span>
    </div>
  );
}

function AxisRow({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  return (
    <div className="mt-1.5 flex gap-[3px]">
      {labels.map((l, i) => (
        <div key={i} className="flex-1 text-center text-[0.55rem] text-white/25">
          {l}
        </div>
      ))}
    </div>
  );
}

/** The performance-color key (+ optional weekend / last-week / target markers). */
function PerfLegend({ target, weekend = false, lastWeek = false }: { target: boolean; weekend?: boolean; lastWeek?: boolean }) {
  const items: { color: string; label: string }[] = [
    { color: "#EF4444", label: "Below" },
    { color: "#2563EB", label: "Met" },
    { color: "#10B981", label: "Over" },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-[0.62rem] text-white/35">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: it.color }} aria-hidden />
          {it.label}
        </span>
      ))}
      {lastWeek && (
        <span className="flex items-center gap-1.5 text-[0.62rem] text-white/35">
          <span className="h-2 w-2 rounded-[2px] bg-white/[0.14]" aria-hidden />
          Last week
        </span>
      )}
      {weekend && (
        <span className="flex items-center gap-1.5 text-[0.62rem] text-white/35">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-white/[0.04]" aria-hidden />
          Weekend
        </span>
      )}
      {target && <span className="text-[0.62rem] text-white/35">╌ target</span>}
    </div>
  );
}
