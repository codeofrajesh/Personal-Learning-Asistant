/**
 * Quick Access — the bottom-right widget from `dashboard Designs/image 3 fav.png`
 * (the "By Platform" ranked list): a compact list of the user's bookmarked materials,
 * each row showing a status check + title + subject caption, with a right-aligned type
 * chip. One-click reopen.
 *
 * Honest data (app rule): fed by the real `bookmarks` rows; empty → a quiet hint about
 * the bookmark action, never placeholder rows.
 *
 * Aesthetic (ui-ux-pro-max): translucent glass shell, rows with a subtle hover glow,
 * a lime check for completed items. lucide-react icons (ui-styling).
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { Bookmark, Check } from "lucide-react";
import type { RecentMaterial } from "../../lib/types";

const TYPE_LABEL: Record<string, string> = {
  video: "Video",
  pdf: "PDF",
  note: "Note",
  image: "Image",
  audio: "Audio",
};

function BookmarkRow({ m }: { m: RecentMaterial }) {
  return (
    <Link
      to={`/library/material/${m.id}`}
      state={{ source: "courses" }}
      className="group flex items-center gap-3 rounded-[14px] px-3 py-2.5 transition-all duration-300 hover:bg-gradient-to-r hover:from-white/[0.06] hover:to-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
    >
      <span
        className={
          "grid h-8 w-8 shrink-0 place-items-center rounded-full border " +
          (m.is_completed
            ? "border-lime/30 bg-lime/10 text-lime"
            : "border-white/[0.08] bg-white/[0.04] text-white/40")
        }
      >
        {m.is_completed ? (
          <Check size={15} strokeWidth={3} aria-hidden />
        ) : (
          <Bookmark size={13} strokeWidth={2} fill="currentColor" aria-hidden />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-content-primary">{m.file_name}</p>
        <p className="truncate text-[0.7rem] text-white/40">{m.subject_name}</p>
      </div>

      <span className="shrink-0 rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[0.64rem] font-medium text-white/50">
        {TYPE_LABEL[m.file_type] ?? m.file_type}
      </span>
    </Link>
  );
}

function QuickAccessView({ items }: { items: RecentMaterial[] }) {
  return (
    <section className="quick-access relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-3 flex items-center gap-2">
        <Bookmark size={16} strokeWidth={2} className="text-lime" fill="currentColor" aria-hidden />
        <h2 className="text-base font-semibold text-content-primary">Quick access</h2>
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <p className="text-sm text-content-secondary">No bookmarks yet</p>
          <p className="max-w-[16rem] text-xs text-white/40">
            Bookmark a material while studying and it lands here for quick reopening.
          </p>
        </div>
      ) : (
        <div className="-mx-1 flex flex-col">
          {items.map((m) => (
            <BookmarkRow key={m.id} m={m} />
          ))}
        </div>
      )}
    </section>
  );
}

export default memo(QuickAccessView);
