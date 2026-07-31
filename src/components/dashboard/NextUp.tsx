/**
 * Next Up — the scheduling widget (distinct from "Recent", which is recency). Surfaces
 * the FIRST unstarted (not-completed) lesson in each active course, in course order,
 * so the learner always sees "the next thing to study". Backed by the `next_up` query
 * (one row per subject, active courses first). Clicking routes into the player.
 *
 * Honest data (app rule): purely computed from real materials/progress; empty when
 * everything is completed or nothing is imported.
 *
 * Aesthetic (ui-ux-pro-max): translucent glass shell, nested rows with a subtle hover
 * glow, a cyan "next" accent + a remaining-count chip. lucide-react icons (ui-styling).
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { ListChecks, Play, FileVideo, FileText, FileAudio, FileImage, File as FileLucide } from "lucide-react";
import type { NextUpItem } from "../../lib/types";

const FILE_ICON: Record<string, typeof FileLucide> = {
  video: FileVideo,
  pdf: FileText,
  note: FileText,
  image: FileImage,
  audio: FileAudio,
};

function NextUpRow({ item }: { item: NextUpItem }) {
  const Icon = FILE_ICON[item.file_type] ?? FileLucide;
  return (
    <Link
      to={`/library/material/${item.id}`}
      state={{ source: "courses" }}
      className="group flex items-center gap-3 rounded-[14px] px-3 py-2.5 transition-all duration-300 hover:bg-gradient-to-r hover:from-white/[0.06] hover:to-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-cyan-400/25 bg-cyan-400/10 text-cyan-400">
        <Icon size={16} strokeWidth={2} aria-hidden />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-content-primary">{item.file_name}</p>
        <p className="truncate text-[0.7rem] text-white/40">
          {item.root_name} · {item.node_name}
        </p>
      </div>

      <span className="shrink-0 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[0.62rem] font-medium text-white/50">
        {item.remaining} left
      </span>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cyan-400/10 text-cyan-400 transition-colors group-hover:bg-cyan-400 group-hover:text-ink-900">
        <Play size={12} strokeWidth={2.5} fill="currentColor" aria-hidden />
      </span>
    </Link>
  );
}

function NextUpView({ items }: { items: NextUpItem[] }) {
  return (
    <section className="next-up relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-3 flex items-center gap-2">
        <ListChecks size={17} strokeWidth={2} className="text-cyan-400" aria-hidden />
        <h2 className="text-base font-semibold text-content-primary">Next up</h2>
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <p className="text-sm text-content-secondary">All caught up</p>
          <p className="max-w-[16rem] text-xs text-white/40">
            Every course is complete — or import a folder to start a new one. The next
            lesson to study appears here.
          </p>
        </div>
      ) : (
        <div className="-mx-1 flex flex-col">
          {items.map((item) => (
            <NextUpRow key={item.root_id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

export default memo(NextUpView);
