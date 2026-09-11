/**
 * FocusQualityBento — three honest "quality of focus" stats over the last 30 days.
 *
 *   • Target-met ratio  — days at/above target ÷ total, with a mini progress bar.
 *   • Session quality    — the sessionized count + average length (NOT raw 15s log rows).
 *   • Longest sprint     — the single longest uninterrupted sitting.
 *
 * All three come straight from the backend payload (`focus_sessions` / `avg_session_secs` /
 * `longest_session_secs` are computed by gap-based sessionization), so they can't be polluted by
 * micro-progress events.
 */

import { Target, Flame, Zap } from "lucide-react";
import type { DayStudy } from "../../lib/types";
import { fmtHMFromSecs, daysMetTarget } from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  daily: DayStudy[];
  focusSessions: number;
  avgSessionSecs: number;
  longestSessionSecs: number;
  targetMins: number | null;
}

const PANEL = "flex h-full flex-col gap-3 rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-4 backdrop-blur-xl";

export default function FocusQualityBento({ daily, focusSessions, avgSessionSecs, longestSessionSecs, targetMins }: Props) {
  const last30 = daily.slice(Math.max(0, daily.length - 30));
  const totalDays = last30.length || 30;
  const met = daysMetTarget(last30, targetMins ?? 0);
  const pct = totalDays > 0 ? Math.round((met / totalDays) * 100) : 0;

  return (
    <div className={PANEL} style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}>
      <div className="text-[0.62rem] font-medium uppercase tracking-wide text-white/40">Focus quality · 30 days</div>

      {/* Target met ratio */}
      <div className="rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-3">
        <div className="flex items-center gap-1.5 text-[0.66rem] text-white/45">
          <Target size={12} strokeWidth={2.25} className="text-[#38BDF8]" aria-hidden />
          Days on target
        </div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span className="text-xl font-bold tabular-nums text-content-primary">{met}</span>
          <span className="text-[0.72rem] text-white/35">/ {totalDays} days · {pct}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: "linear-gradient(90deg, #0e7490, #00D2FF)" }}
          />
        </div>
      </div>

      <Stat icon={Flame} tint="text-lime" label="Focus sessions" value={String(focusSessions)} sub={focusSessions > 0 ? `${fmtHMFromSecs(avgSessionSecs)} average length` : "no sittings yet"} />
      <Stat icon={Zap} tint="text-[#FACC15]" label="Longest deep-work sprint" value={fmtHMFromSecs(longestSessionSecs)} sub="single unbroken sitting" />
    </div>
  );
}

function Stat({ icon: Icon, tint, label, value, sub }: { icon: typeof Flame; tint: string; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 text-[0.66rem] text-white/45">
        <Icon size={12} strokeWidth={2.25} className={cn("shrink-0", tint)} aria-hidden />
        {label}
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums text-content-primary">{value}</div>
      <div className="mt-0.5 text-[0.68rem] text-white/35">{sub}</div>
    </div>
  );
}
