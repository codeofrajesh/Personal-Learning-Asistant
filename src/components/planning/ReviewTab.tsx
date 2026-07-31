/**
 * ReviewTab — the score drill-down (Today / Week / Month / Rolling 90) and the weekly review.
 *
 * ## The single design constraint
 *
 * This is the surface where a student decides whether the app is honest. So:
 *
 *   * **No lifetime score.** Deliberate, and enforced by the backend: after a bad month a
 *     lifetime average is mathematically unrecoverable, which turns feedback into a permanent
 *     indictment. Rolling-90 always recovers, and that difference is the whole point.
 *   * **`null` is not zero.** A window with no signal shows "No data", never a 0 ring. Telling a
 *     student who hasn't used the app yet that they score zero is both wrong and discouraging.
 *   * **The review may not flatter.** It reads from the same rows as the windows above it, and
 *     when the week got worse it says so plainly, then points at the specific thing to change.
 *   * **Neutral days are visible as neutral.** A day with nothing planned and nothing due is not
 *     a failure, and the week strip renders it as an empty track rather than a red mark.
 */

import { useMemo } from "react";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarCheck,
  Flame,
  TrendingUp,
} from "lucide-react";
import ConsistencyHeatmap, { HeatmapLegend } from "./ConsistencyHeatmap";
import { fmtMins } from "./planningUtils";
import { dayHasSignal, type ScoreReviewState, type WeeklyReview } from "./useScoreReview";
import { cn } from "../../lib/utils";
import type { ConsistencyDay, ScoreWindow } from "../../lib/types";

export default function ReviewTab({ review: state }: { review: ScoreReviewState }) {
  const { windows, summary, review, loaded } = state;

  if (loaded && windows.length === 0 && !summary) {
    return (
      <div className="grid min-h-40 place-items-center rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-card text-center text-sm text-white/40 shadow-2xl backdrop-blur-xl">
        Nothing scored yet — plan a day or set a deadline and this fills in.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="plan-panel rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
        <header className="mb-4">
          <h2 className="text-sm font-semibold text-content-primary">How it's going</h2>
          <p className="mt-0.5 text-xs text-white/40">
            Four windows, no lifetime total — a bad month should stop counting against you
            eventually.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {windows.map((w) => (
            <WindowCard key={w.label} window={w} />
          ))}
        </div>
      </section>

      {review && <WeeklyReviewCard review={review} />}

      {summary && summary.days.length > 0 && (
        <section className="plan-panel rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-content-primary">The last 13 weeks</h2>
              <p className="mt-0.5 text-xs text-white/40">
                Blank means nothing was due and nothing was planned — not a missed day.
              </p>
            </div>
            <HeatmapLegend />
          </header>
          <ConsistencyHeatmap days={summary.days} />
        </section>
      )}
    </div>
  );
}

/** One window. `score == null` renders as "No data" — never as zero. */
function WindowCard({ window: w }: { window: ScoreWindow }) {
  const pct = w.score == null ? null : Math.round(w.score);
  const tone =
    pct == null
      ? "text-white/40"
      : pct >= 85
        ? "text-lime"
        : pct >= 60
          ? "text-lime"
          : pct >= 35
            ? "text-cyan-400"
            : "text-orange";

  return (
    <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-[0.66rem] uppercase tracking-wide text-white/35">{w.label}</p>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", tone)}>
        {pct == null ? <span className="text-sm font-medium">No data</span> : pct}
      </p>
      <p className="mt-1.5 text-[0.66rem] leading-snug text-white/40">
        {w.counted_days === 0
          ? "Nothing due or planned"
          : `${w.counted_days} ${w.counted_days === 1 ? "day" : "days"} counted · ${fmtMins(
              w.study_minutes,
            )}`}
      </p>
      {w.blocks_planned > 0 && (
        <p className="mt-0.5 text-[0.66rem] text-white/35">
          {w.blocks_completed}/{w.blocks_planned} blocks done
        </p>
      )}
    </div>
  );
}

/**
 * The weekly review. Every claim here is derived from the same rows as the windows above, and
 * the copy is allowed to deliver bad news — a review that only ever encourages is one the
 * student stops reading.
 */
function WeeklyReviewCard({ review }: { review: WeeklyReview }) {
  const { score, priorScore } = review;
  const delta = score != null && priorScore != null ? score - priorScore : null;

  const headline = useMemo(() => {
    if (score == null) return "A quiet week — nothing was due and nothing was planned.";
    if (delta == null) return "First week with real data. This is the baseline to beat.";
    if (delta >= 5) return "Better than last week.";
    if (delta <= -5) return "Worse than last week.";
    return "About the same as last week.";
  }, [score, delta]);

  return (
    <section className="plan-panel rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-4 flex items-center gap-2">
        <CalendarCheck size={16} strokeWidth={2} className="text-cyan-400" aria-hidden />
        <h2 className="text-sm font-semibold text-content-primary">This week</h2>
      </header>

      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-3xl font-bold tabular-nums text-content-primary">
          {score == null ? "—" : Math.round(score)}
        </span>
        {delta != null && <DeltaBadge delta={delta} />}
        <p className="text-sm text-content-secondary">{headline}</p>
      </div>

      <WeekStrip days={review.days} />

      <dl className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Time studied" value={fmtMins(review.studyMinutes)} />
        <Stat
          label="Blocks done"
          value={
            review.blocksPlanned === 0
              ? "None planned"
              : `${review.blocksCompleted}/${review.blocksPlanned}`
          }
        />
        <Stat
          label="Schedule held"
          value={review.adherence == null ? "No plan" : `${Math.round(review.adherence)}%`}
          hint="Minutes actually worked against minutes planned."
        />
        <Stat
          label="Best run"
          value={
            review.bestStreak === 0
              ? "—"
              : `${review.bestStreak} ${review.bestStreak === 1 ? "day" : "days"}`
          }
          hint="Longest stretch at 60+ in the last 13 weeks."
          icon={review.bestStreak >= 3 ? <Flame size={12} className="text-orange" aria-hidden /> : null}
        />
      </dl>

      {review.worstWeekday && review.bestWeekday && (
        <div className="mt-5 flex items-start gap-2 rounded-[16px] border border-white/[0.06] bg-white/[0.02] p-3.5">
          <TrendingUp size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-lime" aria-hidden />
          <p className="text-[0.72rem] leading-relaxed text-content-secondary">
            Across the last 13 weeks, <strong className="font-semibold text-content-primary">
              {review.bestWeekday.label}s
            </strong>{" "}
            are your strongest day ({Math.round(review.bestWeekday.score ?? 0)}) and{" "}
            <strong className="font-semibold text-content-primary">
              {review.worstWeekday.label}s
            </strong>{" "}
            your weakest ({Math.round(review.worstWeekday.score ?? 0)}). If one day is worth
            re-planning, it's that one.
          </p>
        </div>
      )}
    </section>
  );
}

/** Direction of travel against the previous 7 days. */
function DeltaBadge({ delta }: { delta: number }) {
  const flat = Math.abs(delta) < 5;
  const up = delta > 0;
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.66rem] font-semibold",
        flat
          ? "bg-white/[0.06] text-white/50"
          : up
            ? "bg-lime/10 text-lime"
            : "bg-amber-400/10 text-amber-300",
      )}
    >
      <Icon size={11} strokeWidth={2.5} aria-hidden />
      {delta > 0 ? "+" : ""}
      {Math.round(delta)}
    </span>
  );
}

/** Seven cells, oldest → today. Neutral days are an empty track, not a failure mark. */
function WeekStrip({ days }: { days: ConsistencyDay[] }) {
  return (
    <div className="mt-4 flex gap-1.5">
      {days.map((d) => {
        const signal = dayHasSignal(d);
        const pct = Math.max(0, Math.min(100, d.score));
        const tone = !signal
          ? "bg-white/[0.05]"
          : pct >= 60
            ? "bg-lime"
            : pct >= 35
              ? "bg-cyan-400"
              : "bg-orange";
        return (
          <div key={d.day} className="flex-1">
            <div
              className="h-12 overflow-hidden rounded-[6px] bg-white/[0.04]"
              title={signal ? `${d.day}: ${Math.round(d.score)}` : `${d.day}: nothing due or planned`}
            >
              {signal && (
                <div
                  className={cn("h-full origin-bottom rounded-[6px]", tone)}
                  style={{ transform: `scaleY(${Math.max(0.04, pct / 100)})` }}
                />
              )}
            </div>
            <p className="mt-1 text-center text-[0.58rem] text-white/30">
              {new Date(
                Number(d.day.slice(0, 4)),
                Number(d.day.slice(5, 7)) - 1,
                Number(d.day.slice(8, 10)),
              ).toLocaleDateString(undefined, { weekday: "narrow" })}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div title={hint}>
      <dt className="text-[0.62rem] uppercase tracking-wide text-white/35">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-content-primary">
        {icon}
        {value}
      </dd>
    </div>
  );
}
