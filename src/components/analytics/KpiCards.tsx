/**
 * Top KPI bento cards — a 30-day overview that stays constant as the Day/Week/Month chart below
 * it changes (matching the reference: the headline numbers are always the at-a-glance month-scale
 * figures). Delta chips compare the last 30 days to the 30 before them.
 *
 * All four cards derive from the one `daily` series the hub already fetched — no extra IPC.
 */

import { Clock, Gauge, Trophy, Flame, TrendingUp, TrendingDown } from "lucide-react";
import type { DayStudy } from "../../lib/types";
import {
  fmtHM,
  fmtHMFromSecs,
  fmtDateShort,
  sumMins,
  peakDay,
  delta,
  type Delta,
} from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  /** The full 60-day series (oldest first). */
  daily: DayStudy[];
  /** Sessionized focus-quality stats over the last 30 days (from the backend payload). */
  focusSessions: number;
  avgSessionSecs: number;
}

const CARD =
  "relative overflow-hidden rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-4 backdrop-blur-xl";

function DeltaChip({ d }: { d: Delta }) {
  if (d.isNew) {
    return (
      <span className="rounded-full border border-lime/30 bg-lime/10 px-1.5 py-0.5 text-[0.6rem] font-semibold text-lime">
        New
      </span>
    );
  }
  if (d.pct == null) return null;
  const up = d.up;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[0.6rem] font-semibold tabular-nums",
        up
          ? "border-lime/30 bg-lime/10 text-lime"
          : "border-orange/30 bg-orange/10 text-orange",
      )}
    >
      {up ? <TrendingUp size={11} strokeWidth={2.5} aria-hidden /> : <TrendingDown size={11} strokeWidth={2.5} aria-hidden />}
      {up ? "+" : ""}
      {d.pct}%
    </span>
  );
}

function Card({
  icon: Icon,
  label,
  value,
  sub,
  chip,
  tone = "lime",
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  sub?: string;
  chip?: React.ReactNode;
  tone?: "lime" | "orange" | "cyan";
}) {
  const toneText =
    tone === "orange" ? "text-orange" : tone === "cyan" ? "text-cyan-300" : "text-lime";
  return (
    <div className={CARD} style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}>
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[0.62rem] font-medium uppercase tracking-wide text-white/40">
          <Icon size={13} strokeWidth={2.25} className={cn("shrink-0", toneText)} aria-hidden />
          {label}
        </span>
        {chip}
      </div>
      <div className={cn("text-2xl font-semibold leading-none tabular-nums text-content-primary")}>
        {value}
      </div>
      {sub && <p className="mt-1.5 text-[0.7rem] leading-snug text-white/35">{sub}</p>}
    </div>
  );
}

export default function KpiCards({ daily, focusSessions, avgSessionSecs }: Props) {
  const n = daily.length;
  const last30 = daily.slice(Math.max(0, n - 30));
  const prev30 = daily.slice(Math.max(0, n - 60), Math.max(0, n - 30));

  const totalCur = sumMins(last30);
  const totalPrev = sumMins(prev30);
  const totalDelta = delta(totalCur, totalPrev);

  const avgPerDay = last30.length ? totalCur / last30.length : 0;
  const avgDelta = delta(
    avgPerDay,
    prev30.length ? totalPrev / prev30.length : 0,
  );

  const peak = peakDay(last30);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card
        icon={Clock}
        label="Total · 30 days"
        value={totalCur > 0 ? fmtHM(totalCur) : "0h"}
        sub="vs the previous 30 days"
        chip={<DeltaChip d={totalDelta} />}
        tone="lime"
      />
      <Card
        icon={Gauge}
        label="Daily average"
        value={fmtHM(avgPerDay)}
        sub="per day, across the window"
        chip={<DeltaChip d={avgDelta} />}
        tone="cyan"
      />
      <Card
        icon={Trophy}
        label="Best run"
        value={peak ? fmtHM(peak.work_mins) : "—"}
        sub={peak ? `on ${fmtDateShort(peak.date)}` : "No study logged yet"}
        tone="orange"
      />
      <Card
        icon={Flame}
        label="Focus sessions"
        value={String(focusSessions)}
        sub={focusSessions > 0 ? `${fmtHMFromSecs(avgSessionSecs)} avg length` : "Start a session to begin"}
        tone="lime"
      />
    </div>
  );
}
