/**
 * Progress Statistics card — modelled precisely on `dashboard Designs/image 3 fav.png`
 * (top-left widget): a large headline "% Total Activity", three thin duotone gradient
 * progress bars with their own captions, then a nested darker glass panel holding three
 * icon-circle stats (In Progress · Completed · Total).
 *
 * Honest data (app rule): every number is the real `ProgressStats` from the DB — the
 * ring/bars read 0% on a fresh install, never fabricated.
 *
 * Aesthetic (ui-ux-pro-max dark glassmorphism): translucent card so the page's ambient
 * lighting bleeds through; duotone lime→cyan / cyan→sky / orange gradients on the bars;
 * huge bright numbers vs. tiny text-white/40 labels (design-taste typography hierarchy).
 */

import { memo } from "react";
import { CircleDashed, CheckCircle2, Layers } from "lucide-react";
import type { ProgressStats } from "../../lib/types";

/** One thin duotone progress bar with a caption + right-aligned percentage. */
function GradientBar({
  label,
  pct,
  gradient,
}: {
  label: string;
  pct: number;
  gradient: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[0.7rem] font-medium text-white/40">{label}</span>
        <span className="text-[0.7rem] font-semibold tabular-nums text-white/70">
          {clamped}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={"h-full rounded-full bg-gradient-to-r transition-[width] duration-700 ease-smooth " + gradient}
          style={{ width: `${Math.max(clamped, clamped > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}

/** One icon-circle stat in the nested panel. */
function StatCircle({
  icon: Icon,
  value,
  label,
  ring,
  tint,
}: {
  icon: typeof Layers;
  value: number;
  label: string;
  ring: string;
  tint: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span
        className={
          "grid h-11 w-11 place-items-center rounded-full border bg-white/[0.03] " + ring
        }
      >
        <Icon size={18} strokeWidth={2} className={tint} aria-hidden />
      </span>
      <span className="text-xl font-bold leading-none tabular-nums text-content-primary">
        {value}
      </span>
      <span className="text-center text-[0.68rem] leading-tight text-white/40">{label}</span>
    </div>
  );
}

function ProgressStatsView({ stats }: { stats: ProgressStats }) {
  const total = Math.max(0, stats.total_materials);
  const pctOf = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const activity = Math.max(0, Math.min(100, stats.activity_pct));

  return (
    <section className="stat-card relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <h2 className="text-base font-semibold text-content-primary">Progress statistics</h2>

      {/* Headline % + label */}
      <div className="mt-5 flex items-end gap-3">
        <span className="text-5xl font-bold leading-none tracking-tight text-content-primary">
          {activity}%
        </span>
        <span className="mb-1 text-xs leading-tight text-white/40">
          Total
          <br />
          Activity
        </span>
      </div>

      {/* Three duotone gradient bars */}
      <div className="mt-6 flex flex-col gap-3.5">
        <GradientBar label="Completed" pct={pctOf(stats.completed)} gradient="from-lime to-lime-bright" />
        <GradientBar label="In progress" pct={pctOf(stats.in_progress)} gradient="from-cyan-400 to-sky-300" />
        <GradientBar label="Bookmarked" pct={pctOf(stats.bookmarked)} gradient="from-orange to-orange-bright" />
      </div>

      {/* Nested darker glass panel — three icon-circle stats */}
      <div className="mt-6 grid grid-cols-3 gap-2 rounded-[18px] border border-white/[0.05] bg-black/30 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <StatCircle
          icon={CircleDashed}
          value={stats.in_progress}
          label="In Progress"
          ring="border-lime/30"
          tint="text-lime"
        />
        <StatCircle
          icon={CheckCircle2}
          value={stats.completed}
          label="Completed"
          ring="border-cyan-400/30"
          tint="text-cyan-400"
        />
        <StatCircle
          icon={Layers}
          value={stats.total_materials}
          label="Total"
          ring="border-orange/30"
          tint="text-orange"
        />
      </div>
    </section>
  );
}

export default memo(ProgressStatsView);
