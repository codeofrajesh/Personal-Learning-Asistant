/**
 * Current Course — the featured center widget from `dashboard Designs/image 3 fav.png`.
 * Surfaces the single most-recent in-progress material as a prominent "resume" card:
 * a course/subject title, its chapter + type tags, a participants-style progress panel,
 * and a glowing "Continue Learning" button that routes into the player.
 *
 * Honest data (app rule): fed by the real `continue_learning[0]` row. With nothing
 * watched yet it renders a composed empty state (import prompt), never a fake course.
 *
 * Aesthetic (ui-ux-pro-max): translucent glass so ambient lighting bleeds through, a
 * cyan "Advanced"-style tag + lime primary, a nested progress panel, and a lime CTA
 * with a soft glow. lucide-react icons throughout (ui-styling).
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { Play, Users, Sparkles } from "lucide-react";
import type { RecentMaterial } from "../../lib/types";
import { assetUrl } from "../../lib/ipc";
import { BookOpenIcon } from "../ui/icons";

function CurrentCourseView({ item }: { item: RecentMaterial | null }) {
  if (!item) {
    return (
      <section className="current-course relative flex h-full flex-col items-center justify-center gap-3 overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 text-center shadow-2xl backdrop-blur-xl">
        <span className="grid h-14 w-14 place-items-center rounded-full border border-white/[0.06] bg-white/[0.03]">
          <BookOpenIcon width={26} height={26} className="text-white/30" />
        </span>
        <p className="text-sm font-medium text-content-secondary">No active course yet</p>
        <p className="max-w-[18rem] text-xs text-white/40">
          Import a folder and start a lesson — your current course shows up here so you
          can pick up where you left off.
        </p>
        <Link
          to="/library"
          className="mt-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-semibold text-content-primary transition-colors hover:bg-white/[0.08]"
        >
          Go to Library
        </Link>
      </section>
    );
  }

  const pct = Math.max(0, Math.min(100, item.progress_pct));
  const cover = item.thumbnail_path ? assetUrl(item.thumbnail_path) : "";

  return (
    <section className="current-course relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      {/* faint cover wash behind the content for depth (only if a thumbnail exists) */}
      {cover && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.12] blur-2xl"
          style={{ backgroundImage: `url(${cover})`, backgroundSize: "cover", backgroundPosition: "center" }}
        />
      )}

      <div className="relative flex flex-1 flex-col">
        {/* Tag row */}
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[0.68rem] font-medium text-white/60">
            {item.goal_name}
          </span>
          <span className="flex items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-[0.68rem] font-semibold text-cyan-400">
            <Sparkles size={11} strokeWidth={2.5} aria-hidden />
            In progress
          </span>
        </div>

        {/* Title */}
        <h2 className="mt-4 line-clamp-2 text-xl font-bold leading-snug text-content-primary">
          {item.file_name}
        </h2>
        <p className="mt-2 text-xs text-white/40">
          {item.subject_name} · {item.chapter_name}
        </p>

        {/* Nested progress panel (echoes the reference "Group course 75%" pill) */}
        <div className="mt-5 flex items-center gap-3 rounded-[16px] border border-white/[0.05] bg-black/30 p-3.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-white/[0.04] text-white/60">
            <Users size={16} strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between">
              <span className="text-[0.7rem] font-medium text-white/40">Course progress</span>
              <span className="text-[0.7rem] font-bold tabular-nums text-content-primary">{pct}%</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-lime to-cyan-400 shadow-glow-lime transition-[width] duration-700 ease-smooth"
                style={{ width: `${Math.max(pct, pct > 0 ? 5 : 0)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Glowing Continue Learning CTA */}
        <Link
          to={`/library/material/${item.id}`}
          state={{ source: "courses" }}
          className="group mt-5 flex items-center justify-center gap-2 rounded-full bg-lime px-5 py-3 text-sm font-bold text-ink-900 shadow-[0_0_24px_rgba(170,255,0,0.35)] transition-all hover:shadow-[0_0_36px_rgba(170,255,0,0.55)] hover:brightness-105 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/50 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900"
        >
          <Play size={16} strokeWidth={2.5} fill="currentColor" aria-hidden />
          Continue Learning
        </Link>
      </div>
    </section>
  );
}

export default memo(CurrentCourseView);
