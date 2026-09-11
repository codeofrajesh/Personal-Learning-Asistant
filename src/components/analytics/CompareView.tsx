/**
 * CompareView — the Compare mode: pit two periods against each other.
 *
 *   • Granularity: Day vs Day, Week vs Week, or Month vs Month.
 *   • Two steppers pick Period A (electric blue) and Period B (neon lime/gold); defaults to
 *     previous-vs-current. The Calendar heatmap can also seed a Day-vs-Day compare (the hub owns
 *     the A/B step state, so a heatmap click just sets it).
 *   • A dual-overlaid bar chart (A behind, B in front) plus a head-to-head scorecard: total-hours
 *     delta, daily-average delta, peak-focus-time shift, and target consistency.
 *
 * State is controlled by the hub; data comes from two `useStudyRange` reads. Composited CSS/SVG.
 */

import { useState } from "react";
import { ChevronLeft, ChevronRight, ArrowRight, PieChart, BarChart2 } from "lucide-react";
import type { StudyRange } from "../../lib/types";
import { useScheduleClock } from "../../lib/scheduleClock";
import { currentTier } from "../../lib/perfStore";
import { useStudyRange } from "./useStudyAnalytics";
import PeriodPicker from "./PeriodPicker";
import {
  comparePeriod,
  fmtHM,
  fmtHour12,
  sumMins,
  activeDays,
  delta,
  daysMetTarget,
  goldenWindowFromHourly,
  type Granularity,
  type ComparePeriod,
} from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  targetMins: number | null;
  gran: Granularity;
  setGran: (g: Granularity) => void;
  idxA: number;
  idxB: number;
  setIdxA: (n: number) => void;
  setIdxB: (n: number) => void;
}

const PANEL = "rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl";
const A_COLOR = "#38BDF8";
const B_COLOR = "#AAFF00";
const A_BAR = "linear-gradient(to top, #0e7490, #38BDF8)";
const B_BAR = "linear-gradient(to top, #6FAF00, #AAFF00 70%, #FACC15)";

const GRANS: { key: Granularity; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

export default function CompareView({ targetMins, gran, setGran, idxA, idxB, setIdxA, setIdxB }: Props) {
  const today = useScheduleClock((s) => s.day);
  const pA = comparePeriod(gran, idxA, today);
  const pB = comparePeriod(gran, idxB, today);
  const rA = useStudyRange(pA.start, pA.end);
  const rB = useStudyRange(pB.start, pB.end);
  const [picker, setPicker] = useState<"A" | "B" | null>(null);
  // Default to Pie chart as requested by user
  const [chartMode, setChartMode] = useState<"pie" | "bars">("pie");

  return (
    <div className="space-y-4">
      {/* Granularity + period pickers */}
      <div className={cn(PANEL, "flex flex-wrap items-center justify-between gap-4")}>
        <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
          {GRANS.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setGran(g.key)}
              aria-pressed={gran === g.key}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                gran === g.key
                  ? "bg-white/[0.06] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                  : "text-content-secondary hover:bg-white/[0.04]",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PeriodStepper period={pA} idx={idxA} setIdx={setIdxA} color={A_COLOR} tag="A" onOpen={() => setPicker("A")} />
          <ArrowRight size={16} className="text-white/25" aria-hidden />
          <PeriodStepper period={pB} idx={idxB} setIdx={setIdxB} color={B_COLOR} tag="B" onOpen={() => setPicker("B")} />
        </div>
      </div>

      {/* Comparison chart card with Pie (default) / Timeline Bars switch */}
      <div className={PANEL}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4 text-[0.7rem] text-white/45">
            <Legend color={A_COLOR} label={pA.label} />
            <Legend color={B_COLOR} label={pB.label} />
          </div>

          <div className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5 text-[0.68rem]">
            <button
              type="button"
              onClick={() => setChartMode("pie")}
              aria-pressed={chartMode === "pie"}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition-all duration-200",
                chartMode === "pie"
                  ? "bg-white/[0.10] font-semibold text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]"
                  : "text-content-secondary hover:text-white hover:bg-white/[0.04]",
              )}
            >
              <PieChart size={13} aria-hidden />
              Pie chart
            </button>
            <button
              type="button"
              onClick={() => setChartMode("bars")}
              aria-pressed={chartMode === "bars"}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition-all duration-200",
                chartMode === "bars"
                  ? "bg-white/[0.10] font-semibold text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)]"
                  : "text-content-secondary hover:text-white hover:bg-white/[0.04]",
              )}
            >
              <BarChart2 size={13} aria-hidden />
              Timeline bars
            </button>
          </div>
        </div>

        {chartMode === "pie" ? (
          <ComparePieChart a={rA.data} b={rB.data} pA={pA} pB={pB} />
        ) : (
          <DualChart a={rA.data} b={rB.data} gran={gran} />
        )}
      </div>

      {/* Head-to-head scorecard */}
      <Scorecard a={rA.data} b={rB.data} pA={pA} pB={pB} targetMins={targetMins} />

      <PeriodPicker
        open={picker !== null}
        onClose={() => setPicker(null)}
        gran={gran}
        today={today}
        currentIndex={picker === "B" ? idxB : idxA}
        onSelect={(i) => (picker === "B" ? setIdxB(i) : setIdxA(i))}
      />
    </div>
  );
}

function PeriodStepper({
  period,
  idx,
  setIdx,
  color,
  tag,
  onOpen,
}: {
  period: ComparePeriod;
  idx: number;
  setIdx: (n: number) => void;
  color: string;
  tag: string;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] px-1 py-1">
      <button
        type="button"
        onClick={() => setIdx(idx - 1)}
        disabled={idx <= -60}
        aria-label="Earlier period"
        className="grid h-7 w-7 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-30"
      >
        <ChevronLeft size={16} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onOpen}
        title="Choose period"
        className="min-w-[7.5rem] rounded-lg px-1 py-0.5 text-center transition-colors hover:bg-white/[0.05]"
      >
        <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-content-primary">
          <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
          {period.label}
          <span className="text-[0.6rem] font-medium text-white/30">{tag}</span>
        </div>
        <div className="text-[0.6rem] text-white/30">{period.sub}</div>
      </button>
      <button
        type="button"
        onClick={() => setIdx(idx + 1)}
        disabled={idx >= 0}
        aria-label="Later period"
        className="grid h-7 w-7 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-30"
      >
        <ChevronRight size={16} aria-hidden />
      </button>
    </div>
  );
}

function ComparePieChart({
  a,
  b,
  pA,
  pB,
}: {
  a: StudyRange | null;
  b: StudyRange | null;
  pA: ComparePeriod;
  pB: ComparePeriod;
}) {
  const daysA = a?.daily ?? [];
  const daysB = b?.daily ?? [];
  const totalA = sumMins(daysA);
  const totalB = sumMins(daysB);
  const totalCombined = totalA + totalB;
  const allowGlow = currentTier() !== "lite";

  const pctA = totalCombined > 0 ? (totalA / totalCombined) * 100 : 50;
  const pctB = totalCombined > 0 ? (totalB / totalCombined) * 100 : 50;

  const R = 76;
  const C = 2 * Math.PI * R;
  const lenA = totalCombined > 0 ? (totalA / totalCombined) * C : 0;
  const lenB = totalCombined > 0 ? (totalB / totalCombined) * C : 0;

  const d = delta(totalB, totalA);
  const avgA = daysA.length ? Math.round(totalA / daysA.length) : 0;
  const avgB = daysB.length ? Math.round(totalB / daysB.length) : 0;
  const actA = activeDays(daysA);
  const actB = activeDays(daysB);

  return (
    <div className="flex flex-col items-center justify-between gap-6 py-3 md:flex-row md:gap-10">
      {/* SVG Donut Pie Chart */}
      <div className="relative flex shrink-0 items-center justify-center">
        <svg
          viewBox="0 0 200 200"
          className="h-48 w-48 -rotate-90 sm:h-52 sm:w-52"
          role="img"
          aria-label={`Study time share: ${pA.label} ${pctA.toFixed(0)}% vs ${pB.label} ${pctB.toFixed(0)}%`}
        >
          {/* Base background track */}
          <circle
            cx={100}
            cy={100}
            r={R}
            fill="none"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={22}
          />
          {totalCombined > 0 ? (
            <>
              {/* Period A Slice */}
              {totalA > 0 && (
                <circle
                  cx={100}
                  cy={100}
                  r={R}
                  fill="none"
                  stroke={A_COLOR}
                  strokeWidth={22}
                  strokeDasharray={`${lenA} ${C}`}
                  strokeDashoffset={0}
                  className="transition-all duration-700 ease-out"
                  style={{
                    filter: allowGlow ? "drop-shadow(0 0 6px rgba(56,189,248,0.5))" : undefined,
                  }}
                />
              )}
              {/* Period B Slice */}
              {totalB > 0 && (
                <circle
                  cx={100}
                  cy={100}
                  r={R}
                  fill="none"
                  stroke={B_COLOR}
                  strokeWidth={22}
                  strokeDasharray={`${lenB} ${C}`}
                  strokeDashoffset={-lenA}
                  className="transition-all duration-700 ease-out"
                  style={{
                    filter: allowGlow ? "drop-shadow(0 0 6px rgba(170,255,0,0.45))" : undefined,
                  }}
                />
              )}
            </>
          ) : (
            <circle
              cx={100}
              cy={100}
              r={R}
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={22}
              strokeDasharray="4 6"
            />
          )}
        </svg>

        {/* Donut Center Readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
          <span className="text-[0.62rem] font-medium uppercase tracking-wider text-white/40">
            Total
          </span>
          <span className="text-xl font-bold tabular-nums text-content-primary sm:text-2xl">
            {fmtHM(totalCombined)}
          </span>
          <span className="text-[0.6rem] text-white/30">
            {totalCombined > 0 ? `${Math.max(pctA, pctB).toFixed(0)}% leader` : "no study"}
          </span>
        </div>
      </div>

      {/* Comparative Cards: Period A vs Period B */}
      <div className="grid w-full flex-1 gap-3 sm:grid-cols-2">
        {/* Period A Card */}
        <div
          className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4 transition-colors"
          style={{ borderLeft: `3px solid ${A_COLOR}` }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-content-primary">
              <span className="h-2 w-2 rounded-full" style={{ background: A_COLOR }} aria-hidden />
              {pA.label}
              <span className="text-[0.6rem] font-medium text-white/30">A</span>
            </div>
            <span className="rounded-full bg-[#38BDF8]/10 px-2 py-0.5 text-[0.62rem] font-semibold tabular-nums text-[#38BDF8]">
              {totalCombined > 0 ? `${pctA.toFixed(1)}% share` : "—"}
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums text-[#38BDF8]">
            {fmtHM(totalA)}
          </div>
          <div className="mt-2 flex items-center justify-between text-[0.65rem] text-white/40">
            <span>{actA} active {actA === 1 ? "day" : "days"}</span>
            <span>Avg {fmtHM(avgA)}/d</span>
          </div>
          {/* Progress bar representing share */}
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pctA}%`, background: A_COLOR }}
            />
          </div>
        </div>

        {/* Period B Card */}
        <div
          className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4 transition-colors"
          style={{ borderLeft: `3px solid ${B_COLOR}` }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-content-primary">
              <span className="h-2 w-2 rounded-full" style={{ background: B_COLOR }} aria-hidden />
              {pB.label}
              <span className="text-[0.6rem] font-medium text-white/30">B</span>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[0.62rem] font-semibold tabular-nums",
                d.isNew || d.pct == null
                  ? "bg-white/[0.06] text-white/50"
                  : d.up
                    ? "bg-lime/10 text-lime"
                    : "bg-orange/10 text-orange",
              )}
            >
              {totalCombined > 0 ? `${pctB.toFixed(1)}% share` : "—"}
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums text-lime">
            {fmtHM(totalB)}
          </div>
          <div className="mt-2 flex items-center justify-between text-[0.65rem] text-white/40">
            <span>{actB} active {actB === 1 ? "day" : "days"}</span>
            <span>Avg {fmtHM(avgB)}/d</span>
          </div>
          {/* Progress bar representing share */}
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pctB}%`, background: B_COLOR }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function DualChart({ a, b, gran }: { a: StudyRange | null; b: StudyRange | null; gran: Granularity }) {
  const daysA = a?.daily ?? [];
  const daysB = b?.daily ?? [];
  const len = Math.max(daysA.length, daysB.length, 1);
  const scaleMax = Math.max(1, ...daysA.map((d) => d.work_mins), ...daysB.map((d) => d.work_mins));
  const allowGlow = currentTier() !== "lite";
  const wide = gran === "day"; // a single position reads better as two fat bars

  return (
    <div className="flex h-52 items-end gap-[3px]">
      {Array.from({ length: len }).map((_, i) => {
        const va = daysA[i]?.work_mins ?? 0;
        const vb = daysB[i]?.work_mins ?? 0;
        const ha = va > 0 ? Math.max(3, (va / scaleMax) * 100) : 0;
        const hb = vb > 0 ? Math.max(3, (vb / scaleMax) * 100) : 0;
        return (
          <div key={i} className="relative flex h-full flex-1 items-end justify-center">
            {/* Period A — behind, wider, translucent */}
            <div
              className="absolute bottom-0 rounded-t-[3px]"
              style={{ height: `${ha}%`, width: wide ? "68%" : "100%", background: A_BAR, opacity: 0.55 }}
              title={daysA[i] ? `A · ${daysA[i].date} · ${fmtHM(va)}` : undefined}
            />
            {/* Period B — front, narrower, solid */}
            <div
              className="relative rounded-t-[3px] transition-[height] duration-500"
              style={{
                height: `${hb}%`,
                width: wide ? "40%" : "58%",
                background: B_BAR,
                boxShadow: allowGlow && vb > 0 ? `0 0 8px -2px ${B_COLOR}` : undefined,
              }}
              title={daysB[i] ? `B · ${daysB[i].date} · ${fmtHM(vb)}` : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

function Scorecard({
  a,
  b,
  pA,
  pB,
  targetMins,
}: {
  a: StudyRange | null;
  b: StudyRange | null;
  pA: ComparePeriod;
  pB: ComparePeriod;
  targetMins: number | null;
}) {
  const daysA = a?.daily ?? [];
  const daysB = b?.daily ?? [];
  const totalA = sumMins(daysA);
  const totalB = sumMins(daysB);
  const totalDelta = delta(totalB, totalA);

  const avgA = daysA.length ? totalA / daysA.length : 0;
  const avgB = daysB.length ? totalB / daysB.length : 0;
  const avgDelta = delta(avgB, avgA);

  const target = targetMins ?? 0;
  const metA = daysA.length ? Math.round((daysMetTarget(daysA, target) / daysA.length) * 100) : 0;
  const metB = daysB.length ? Math.round((daysMetTarget(daysB, target) / daysB.length) * 100) : 0;

  const gwA = a ? goldenWindowFromHourly(a.hourly) : null;
  const gwB = b ? goldenWindowFromHourly(b.hourly) : null;
  const peakA = gwA ? `${fmtHour12(gwA.startHour)}–${fmtHour12(gwA.endHour + 1)}` : "—";
  const peakB = gwB ? `${fmtHour12(gwB.startHour)}–${fmtHour12(gwB.endHour + 1)}` : "—";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ScoreRow
        title="Total hours"
        aLabel={pA.label}
        bLabel={pB.label}
        aVal={fmtHM(totalA)}
        bVal={fmtHM(totalB)}
        deltaText={deltaLabel(totalDelta, "higher", "lower")}
        deltaUp={totalDelta.up}
      />
      <ScoreRow
        title="Daily average"
        aLabel={pA.label}
        bLabel={pB.label}
        aVal={fmtHM(avgA)}
        bVal={fmtHM(avgB)}
        deltaText={deltaLabel(avgDelta, "higher", "lower")}
        deltaUp={avgDelta.up}
      />
      <ScoreRow
        title="Peak focus time"
        aLabel={pA.label}
        bLabel={pB.label}
        aVal={peakA}
        bVal={peakB}
        deltaText={gwA && gwB ? (gwA.startHour === gwB.startHour ? "same window" : "shifted") : "not enough data"}
        deltaUp
        neutral
      />
      <ScoreRow
        title="Days on target"
        aLabel={pA.label}
        bLabel={pB.label}
        aVal={`${metA}%`}
        bVal={`${metB}%`}
        deltaText={metB === metA ? "same" : metB > metA ? `+${metB - metA} pts` : `${metB - metA} pts`}
        deltaUp={metB >= metA}
      />
    </div>
  );
}

function deltaLabel(d: { pct: number | null; up: boolean; isNew: boolean }, up: string, down: string): string {
  if (d.isNew) return "new";
  if (d.pct == null) return "—";
  if (d.pct === 0) return "no change";
  return `${Math.abs(d.pct)}% ${d.up ? up : down}`;
}

function ScoreRow({
  title,
  aLabel,
  bLabel,
  aVal,
  bVal,
  deltaText,
  deltaUp,
  neutral = false,
}: {
  title: string;
  aLabel: string;
  bLabel: string;
  aVal: string;
  bVal: string;
  deltaText: string;
  deltaUp: boolean;
  neutral?: boolean;
}) {
  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between">
        <span className="text-[0.62rem] font-medium uppercase tracking-wide text-white/40">{title}</span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold",
            neutral
              ? "border-white/10 bg-white/[0.04] text-white/50"
              : deltaUp
                ? "border-lime/30 bg-lime/10 text-lime"
                : "border-orange/30 bg-orange/10 text-orange",
          )}
        >
          {deltaText}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[0.62rem] text-white/40">
            <span className="h-2 w-2 rounded-full" style={{ background: A_COLOR }} aria-hidden />
            {aLabel}
          </div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-[#38BDF8]">{aVal}</div>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[0.62rem] text-white/40">
            <span className="h-2 w-2 rounded-full" style={{ background: B_COLOR }} aria-hidden />
            {bLabel}
          </div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-lime">{bVal}</div>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}
