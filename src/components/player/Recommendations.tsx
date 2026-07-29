/**
 * Recommendations — the "Suggested lectures" rail below the video. Fetches ranked
 * suggestions (next-in-series → same course → same goal) and renders them as compact
 * cards with a CoverArt thumbnail, a reason tag, duration, and progress. Clicking a card
 * opens that material in the player (carrying the launch source for breadcrumbs).
 *
 * Reloads when the material changes. Hidden entirely when there's nothing to suggest, so
 * it never shows an empty shell.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PlayCircle } from "lucide-react";
import CoverArt from "../ui/CoverArt";
import { ipc, isTauri } from "../../lib/ipc";
import { withSource, type NavSource } from "../../lib/navigation";
import { formatDuration } from "../../lib/utils";
import { cn } from "../../lib/utils";
import type { Recommendation } from "../../lib/types";

const REASON_LABEL: Record<string, string> = {
  next: "Up next",
  course: "Same course",
  goal: "Same goal",
};

const TYPE_GLYPH: Record<string, string> = { video: "🎬", pdf: "📄", note: "📝", image: "🖼️", audio: "🎧" };

interface Props {
  materialId: number;
  source: NavSource;
}

export default function Recommendations({ materialId, source }: Props) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Recommendation[] | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setItems(null);
    ipc
      .recommendedMaterials(materialId, 8)
      .then((r) => {
        if (!cancelled) setItems(r);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  if (!items || items.length === 0) return null;

  return (
    <section className="mt-6">
      <h3 className="mb-3 text-sm font-semibold text-content-primary">Suggested lectures</h3>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((rec) => {
          const pct = Math.max(0, Math.min(100, rec.progress_pct));
          return (
            <li key={rec.id} className="cv-row-lg">
              <button
                type="button"
                onClick={() => navigate(`/library/material/${rec.id}`, withSource(source))}
                className="group flex w-full gap-3 rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-2 text-left transition-colors hover:border-white/10 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
              >
                {/* Thumbnail */}
                <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-[10px]">
                  <CoverArt
                    thumbnailPath={rec.thumbnail_path}
                    seed={rec.id}
                    glyph={TYPE_GLYPH[rec.file_type] ?? "📄"}
                    className="h-full w-full"
                  />
                  <span className="absolute inset-0 z-10 grid place-items-center opacity-0 transition-opacity group-hover:opacity-100">
                    <PlayCircle size={26} className="text-white drop-shadow" aria-hidden />
                  </span>
                  {rec.duration_secs != null && rec.duration_secs > 0 && (
                    <span className="absolute bottom-1 right-1 z-10 rounded bg-black/75 px-1 py-0.5 text-[10px] font-medium text-white tabular-nums">
                      {formatDuration(rec.duration_secs)}
                    </span>
                  )}
                </div>

                {/* Meta */}
                <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
                  <span
                    className={cn(
                      "w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      rec.reason === "next"
                        ? "bg-lime/15 text-lime"
                        : rec.reason === "course"
                          ? "bg-cyan-400/15 text-cyan-300"
                          : "bg-white/[0.06] text-content-secondary",
                    )}
                  >
                    {REASON_LABEL[rec.reason] ?? "Suggested"}
                  </span>
                  <p className="line-clamp-2 text-xs font-medium leading-snug text-content-primary" title={rec.file_name}>
                    {rec.file_name}
                  </p>
                  <p className="truncate text-[11px] text-content-faint">{rec.subject_name}</p>
                  {pct > 0 && (
                    <div className="mt-auto h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                      <div className="h-full rounded-full bg-lime/70" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
