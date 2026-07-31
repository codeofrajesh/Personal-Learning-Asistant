/**
 * Consistency heatmap — a GitHub-contributions-style intensity grid modelled on the
 * "Course engagement" card in `dashboard Designs/image copy 2 fav.png`: weekday rows
 * (Sun→Sat) × week columns, each cell shaded across a 4-step ramp with a
 * Low·Medium·High·Best legend.
 *
 * Pure CSS grid of `<div>`s (no chart library) — cell color derives from that day's
 * consistency score bucket. Cells stagger-reveal on mount via GSAP (reduced-motion
 * gated). Hovering a cell shows its date + score via the native title.
 *
 * The lime ramp keeps it on-brand; empty/neutral days render as a faint track so the
 * grid shape is always complete (never a blank hole).
 */

import { memo, useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { motionAllowed } from "../../lib/perfStore";
import { dayHasSignal } from "./useScoreReview";
import type { ConsistencyDay } from "../../lib/types";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Score → 0-4 intensity bucket (0 = no signal, 1 Low … 4 Best).
 *  Uses the SHARED signal test: a day where the student planned and worked a schedule but had
 *  no deadline due used to render as an empty cell, which reads as "did nothing". */
function bucket(d: ConsistencyDay): number {
  if (!dayHasSignal(d)) return 0;
  if (d.score >= 85) return 4;
  if (d.score >= 60) return 3;
  if (d.score >= 35) return 2;
  return 1;
}

const CELL_CLASS = [
  "bg-white/[0.04]", // 0 — neutral/no signal
  "bg-lime/20", // 1 Low
  "bg-lime/40", // 2 Medium
  "bg-lime/70", // 3 High
  "bg-lime", // 4 Best
];

/** Local YYYY-MM-DD. */
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ConsistencyHeatmapView({ days }: { days: ConsistencyDay[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const byDay = new Map(days.map((d) => [d.day, d]));

  // Build fixed weekday-row × week-column columns ending this week. We render the last
  // 13 weeks (91 days) so the grid is always a complete rectangle regardless of data.
  const weeks = 13;
  const today = new Date();
  // Anchor to the end of the current week (Saturday) so columns align by week.
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const columns: Date[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const col: Date[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(end);
      d.setDate(end.getDate() - w * 7 - (6 - dow));
      col.push(d);
    }
    columns.push(col);
  }

  useLayoutEffect(() => {
    if (!motionAllowed()) return;
    const ctx = gsap.context(() => {
      gsap.from(".heat-cell", {
        opacity: 0,
        scale: 0.6,
        duration: 0.35,
        ease: "power2.out",
        stagger: { each: 0.004, from: "start" },
      });
    }, rootRef);
    return () => ctx.revert();
  }, [days]);

  const todayIso = isoLocal(today);

  return (
    <div ref={rootRef} className="flex gap-3">
      {/* Weekday labels (show every other one to save space) */}
      <div className="flex flex-col justify-between py-[2px] text-[0.6rem] text-white/30">
        {DOW.map((d, i) => (
          <span key={d} className="h-3 leading-3">
            {i % 2 === 1 ? d : ""}
          </span>
        ))}
      </div>

      {/* Week columns */}
      <div className="flex flex-1 gap-1 overflow-hidden">
        {columns.map((col, ci) => (
          <div key={ci} className="flex flex-1 flex-col gap-1">
            {col.map((d) => {
              const iso = isoLocal(d);
              const future = iso > todayIso;
              const row = byDay.get(iso);
              const b = row ? bucket(row) : 0;
              return (
                <div
                  key={iso}
                  className={
                    "heat-cell aspect-square rounded-[3px] " +
                    (future ? "bg-transparent" : CELL_CLASS[b]) +
                    (iso === todayIso ? " ring-1 ring-white/40" : "")
                  }
                  title={
                    future
                      ? ""
                      : row
                        ? `${iso}: ${Math.round(row.score)} score`
                        : `${iso}: no activity`
                  }
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The Low·Medium·High·Best legend (shares the ramp with the cells). */
export function HeatmapLegend() {
  const labels = ["Low", "Medium", "High", "Best"];
  return (
    <div className="flex items-center gap-3 text-[0.62rem] text-white/40">
      {labels.map((label, i) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className={"h-2.5 w-2.5 rounded-[3px] " + CELL_CLASS[i + 1]} aria-hidden />
          {label}
        </span>
      ))}
    </div>
  );
}

export default memo(ConsistencyHeatmapView);
