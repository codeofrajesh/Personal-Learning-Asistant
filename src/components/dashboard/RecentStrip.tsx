/**
 * Recent — the "quick-resume" strip (formerly mislabelled "My schedule"). A horizontally
 * scrollable row of the most recently OPENED lessons (`continue_learning`, ordered by
 * `last_opened_at DESC`). This is honest recency, not scheduling — the "Next Up" widget
 * owns the scheduling algorithm (first unstarted lesson per course).
 *
 * Each card shows a type tag, the lesson title, a colored "level" pill (its goal), and a
 * context line (subject) with a play affordance. Empty → a composed prompt.
 *
 * Aesthetic (ui-ux-pro-max): translucent glass shell; each item is a nested darker glass
 * card with a subtle inner sheen + hover lift. Horizontal scroll uses `.scroll-thin`.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { Play, Clock, History } from "lucide-react";
import type { RecentMaterial } from "../../lib/types";

/** File-type → colored level pill treatment (echoes the reference's Beginner/Advanced). */
const TYPE_PILL: Record<string, string> = {
  video: "border-lime/25 bg-lime/10 text-lime",
  pdf: "border-orange/25 bg-orange/10 text-orange",
  note: "border-cyan-400/25 bg-cyan-400/10 text-cyan-400",
  image: "border-sky-300/25 bg-sky-300/10 text-sky-300",
  audio: "border-violet-400/25 bg-violet-400/10 text-violet-300",
};

function RecentCard({ m }: { m: RecentMaterial }) {
  const pill = TYPE_PILL[m.file_type] ?? "border-white/10 bg-white/[0.05] text-white/60";
  return (
    <Link
      to={`/library/material/${m.id}`}
      state={{ source: "courses" }}
      className="group flex w-64 shrink-0 flex-col rounded-[18px] border border-white/[0.05] bg-black/30 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-300 hover:-translate-y-0.5 hover:border-white/[0.1] hover:bg-white/[0.04] hover:shadow-[0_8px_28px_rgba(0,0,0,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
    >
      <div className="flex items-center gap-1.5 text-[0.68rem] text-white/40">
        <Clock size={12} strokeWidth={2} aria-hidden />
        <span className="uppercase tracking-wide">{m.file_type}</span>
      </div>

      <h3 className="mt-2 line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-content-primary">
        {m.file_name}
      </h3>

      <span className={"mt-3 w-fit rounded-full border px-2.5 py-1 text-[0.64rem] font-semibold " + pill}>
        {m.goal_name}
      </span>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/[0.05] pt-3">
        <p className="min-w-0 truncate text-[0.7rem] text-white/40">{m.subject_name}</p>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-lime/10 text-lime transition-colors group-hover:bg-lime group-hover:text-ink-900">
          <Play size={12} strokeWidth={2.5} fill="currentColor" aria-hidden />
        </span>
      </div>
    </Link>
  );
}

function RecentStripView({ items }: { items: RecentMaterial[] }) {
  return (
    <section className="recent-strip relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-4 flex items-center gap-2">
        <History size={17} strokeWidth={2} className="text-content-secondary" aria-hidden />
        <h2 className="text-base font-semibold text-content-primary">Recent</h2>
        {items.length > 0 && (
          <span className="ml-auto text-xs text-white/40">{items.length} recently opened</span>
        )}
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
          <p className="text-sm text-content-secondary">Nothing opened yet</p>
          <p className="max-w-[20rem] text-xs text-white/40">
            Lessons you open appear here as a quick-resume timeline.
          </p>
        </div>
      ) : (
        <div className="scroll-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
          {items.map((m) => (
            <RecentCard key={m.id} m={m} />
          ))}
        </div>
      )}
    </section>
  );
}

export default memo(RecentStripView);
