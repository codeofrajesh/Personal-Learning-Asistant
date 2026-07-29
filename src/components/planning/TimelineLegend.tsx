/**
 * TimelineLegend — a compact, glassmorphic key explaining the Timeline's visual language:
 * the status color-coding (upcoming / due soon / overdue / done) and the type icons
 * (task / video / pdf / note / audio / image). Sits in a corner of the calendar so the
 * color + icon vocabulary is always decodable at a glance. Purely presentational and
 * rendered in normal flow so it never obscures calendar content or keyboard focus.
 */

import { SOON_META, OVERDUE_META, DONE_META, UPCOMING_META } from "./planningUtils";
import { GlyphFor, ICON_KIND_LABEL, ICON_LEGEND_ORDER } from "./TaskGlyph";
import { cn } from "../../lib/utils";

const STATUS_ROWS: { label: string; dot: string }[] = [
  { label: "Upcoming", dot: UPCOMING_META.dot },
  { label: "Due soon", dot: SOON_META.dot },
  { label: "Overdue", dot: OVERDUE_META.dot },
  { label: "Done", dot: DONE_META.dot },
];

export default function TimelineLegend() {
  return (
    <div className="scroll-thin overflow-x-auto rounded-[14px] border border-white/[0.08] bg-ink-850/70 px-3 py-2.5 shadow-2xl backdrop-blur-xl [box-shadow:0_16px_40px_-12px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.06)]">
      <div className="flex min-w-max items-center gap-x-4">
        {/* Status colours */}
        <div className="flex items-center gap-3">
          <span className="text-[0.6rem] font-semibold uppercase tracking-wide text-content-muted">Status</span>
          <div className="flex items-center gap-2.5">
            {STATUS_ROWS.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 text-[0.66rem] text-content-secondary">
                <span className={cn("h-2 w-2 rounded-full", s.dot)} aria-hidden />
                {s.label}
              </span>
            ))}
          </div>
        </div>

        <span className="hidden h-4 w-px bg-white/[0.08] sm:block" aria-hidden />

        {/* Type icons */}
        <div className="flex items-center gap-3">
          <span className="text-[0.6rem] font-semibold uppercase tracking-wide text-content-muted">Type</span>
          <div className="flex items-center gap-2.5">
            {ICON_LEGEND_ORDER.map((kind) => (
              <span key={kind} className="flex items-center gap-1 text-[0.66rem] text-content-secondary" title={ICON_KIND_LABEL[kind]}>
                <GlyphFor kind={kind} size={12} className="text-white/50" />
                {ICON_KIND_LABEL[kind].split(" ")[0]}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
