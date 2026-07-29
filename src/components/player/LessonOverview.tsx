/**
 * Lesson Overview — the right-column panel in the premium player layout.
 *
 * A rounded, opaque card with an accordion-style list of the current chapter's lessons.
 * The active lesson is highlighted with a prominent accent background. Clicking a
 * lesson navigates to that material's player route.
 *
 * Replaces the old ChapterSidebar in the player page.
 */

import { memo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { MaterialRow } from "../../lib/types";
import { withSource, type NavSource } from "../../lib/navigation";
import { cn } from "../../lib/utils";
import { ChevronDown, ChevronUp, CheckCircle, AlertTriangle, Video, PlayCircle, Circle, AudioLines } from "lucide-react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { convertFileSrc } from "@tauri-apps/api/core";

gsap.registerPlugin(useGSAP);

function formatTime(secs: number | null): string {
  if (secs == null || isNaN(secs) || secs <= 0) return "--:--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  siblings: MaterialRow[];
  currentId: number;
  /** Where the player was launched from — carried forward on lesson-to-lesson jumps
   *  so the Courses/Library breadcrumb + sidebar context is never lost. */
  source: NavSource;
}

function LessonOverviewView({ siblings, currentId, source }: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useGSAP(() => {
    // Stagger animation from the bottom up on mount
    gsap.from(".lesson-card", {
      y: 40,
      opacity: 0,
      duration: 0.6,
      stagger: 0.08,
      ease: "power3.out",
      clearProps: "all"
    });
  }, { scope: containerRef });

  useGSAP(() => {
    // Smooth reveal for the expanded active card details whenever expandedId changes
    gsap.fromTo(".expanded-stagger", 
      { height: 0, opacity: 0, scale: 0.98 },
      { height: "auto", opacity: 1, scale: 1, duration: 0.4, stagger: 0.05, ease: "power2.out", clearProps: "all" }
    );
  }, { scope: containerRef, dependencies: [expandedId] });

  useGSAP(() => {
    // Continuous pulsating animation for the playing icon and text
    gsap.to(".playing-icon-pulse", {
      scale: 1.25,
      opacity: 0.4,
      duration: 0.6,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut"
    });
    gsap.to(".playing-text-pulse", {
      opacity: 0.7,
      duration: 1.2,
      yoyo: true,
      repeat: -1,
      ease: "sine.inOut"
    });
  }, { scope: containerRef, dependencies: [currentId] });

  return (
    <aside 
      ref={containerRef}
      className="flex h-full w-[480px] flex-col rounded-[32px] bg-[#F4F4F6] p-7 shadow-2xl font-sans mx-6 mb-6 overflow-hidden mt-6"
    >
      {/* Header */}
      <div className="shrink-0 pb-6 pl-2 pt-2">
        <h2 className="text-[24px] font-medium tracking-tight text-[#1A1A24]" title="Lesson Overview">
          Lesson Overview
        </h2>
      </div>

      {/* Lesson list */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-2">
        <ul className="flex flex-col gap-4 pb-4">
          {siblings.map((m, i) => {
            // 0..100 clamped progress percentage
            const pct = Math.max(0, Math.min(100, m.progress_pct));
            
            // Calculate effective display percentage (YouTube revision tracking logic)
            let displayPct = pct;
            if (m.is_completed) {
              if (pct === 0 || pct >= 95) {
                displayPct = 100; // Full bar for newly/manually completed
              } else {
                displayPct = pct; // Actual partial progress for active revisions
              }
            }
            
            const isCurrent = m.id === currentId;
            const missing = m.status === "missing";
            
            // Format duration from DB
            const effDuration = m.duration_secs;
            const durationFormatted = formatTime(effDuration);

            // Calculate watched duration
            const watchedSecs = effDuration != null ? (effDuration * pct) / 100 : null;
            const watchedFormatted = formatTime(watchedSecs);
            const isExpanded = expandedId === m.id;

            if (missing) {
              return (
                <li key={m.id} className="lesson-card">
                  <div className="flex items-center justify-between rounded-[24px] bg-[#2D2D32] px-6 py-5 opacity-50">
                     <span className="text-[16px] font-normal text-white line-clamp-2 pr-4">{i + 1}. {m.file_name}</span>
                     <span className="shrink-0 text-[#F5A623]"><AlertTriangle size={16} /></span>
                  </div>
                </li>
              );
            }

            return (
              <li key={m.id} className="lesson-card cv-row-lg relative group">
                <div
                  onClick={() => navigate(`/library/material/${m.id}`, withSource(source))}
                  className={cn(
                    "flex flex-col gap-3 rounded-[24px] px-6 py-5 transition-all duration-300 block cursor-pointer",
                    isCurrent
                      ? "bg-[#D0B7FF] shadow-sm transform scale-[1.02]"
                      : "bg-[#2D2D32] hover:bg-[#3A3A40] hover:scale-[1.01]"
                  )}
                  aria-current={isCurrent ? "true" : undefined}
                >
                  {/* Top row: Title and duration + controls */}
                  <div className="flex items-center justify-between gap-4">
                    <p className={cn(
                      "text-[16px] leading-snug font-medium line-clamp-2",
                      isCurrent ? "text-[#1A1A24]" : "text-[#F4F4F5]"
                    )} title={m.file_name}>
                      {i + 1}. {m.file_name}
                    </p>
                    <div className="flex shrink-0 items-center gap-3 pt-0.5">
                      {/* Status Icon & Duration */}
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "text-[14px] font-medium tracking-tight",
                          isCurrent ? "text-[#1A1A24]/70" : "text-white/60"
                        )}>
                          {durationFormatted}
                        </span>
                        {!isCurrent && (
                          m.is_completed ? (
                            <CheckCircle size={16} className="text-[#A3E635]" strokeWidth={2.5} />
                          ) : pct > 0 ? (
                            <PlayCircle size={16} className="text-[#D0B7FF]" strokeWidth={2.5} />
                          ) : (
                            <Circle size={16} className="text-white/20" strokeWidth={2.5} />
                          )
                        )}
                      </div>
                      
                      {/* Playing Indicator OR Expand Arrow */}
                      {isCurrent ? (
                        <div className="flex items-center gap-1.5 rounded-full bg-[#1A1A24] px-3 py-1.5 text-[#D0B7FF] shadow-sm">
                          <AudioLines size={18} strokeWidth={2.5} className="playing-icon-pulse" />
                          <span className="text-[11px] font-bold uppercase tracking-widest playing-text-pulse">Playing</span>
                        </div>
                      ) : (
                        <button 
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setExpandedId(isExpanded ? null : m.id);
                          }}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#1C1C20] text-white transition-transform hover:bg-black"
                        >
                          {isExpanded ? <ChevronUp size={18} strokeWidth={2.5} /> : <ChevronDown size={18} strokeWidth={2.5} />}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded YouTube-style content (Only for non-current, expanded cards) */}
                  {isExpanded && !isCurrent && (
                    <div className="expanded-stagger mt-2 flex flex-col gap-3 overflow-hidden origin-top">
                      {/* 16:9 Thumbnail Box */}
                      <div className="relative w-full rounded-xl bg-black/5 aspect-video overflow-hidden shadow-inner flex items-center justify-center border border-white/10">
                        {m.thumbnail_path ? (
                          <img src={convertFileSrc(m.thumbnail_path)} alt={m.file_name} className="absolute inset-0 h-full w-full object-cover" />
                        ) : (
                          <Video size={32} className="text-[#1A1A24]/20" />
                        )}
                        
                        {/* YouTube Style Duration Pill */}
                        <div className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white shadow backdrop-blur-sm tracking-wide">
                          {durationFormatted}
                        </div>
                        
                        {/* Optional status overlay */}
                        {m.is_completed && (
                          <div className="absolute top-2 right-2 rounded bg-[#A3E635]/90 px-1.5 py-0.5 text-[11px] font-bold text-ink-900 shadow backdrop-blur-sm tracking-wide">
                            COMPLETED
                          </div>
                        )}
                      </div>
                      
                      {/* Progress Stats */}
                      <div className="flex flex-col gap-1.5">
                        <div className="h-[5px] w-full overflow-hidden rounded-full bg-black/40 shadow-inner">
                          <div className="h-full rounded-full bg-[#A3E635] shadow-[0_0_8px_rgba(163,230,53,0.5)] transition-all duration-500" style={{ width: `${displayPct}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[13px] font-medium text-white/70 px-1">
                          <span>{Math.round(displayPct)}% completed</span>
                          <span>{watchedFormatted} / {durationFormatted}</span>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {/* Premium Progress indicator for compressed cards */}
                  {(!isExpanded || isCurrent) && (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className={cn(
                        "h-[6px] flex-1 overflow-hidden rounded-full shadow-inner ring-1",
                        isCurrent 
                          ? "bg-black/10 ring-black/5" 
                          : (m.is_completed ? "bg-[#A3E635]/15 ring-[#A3E635]/25" : "bg-black/40 ring-white/5")
                      )}>
                        <div 
                          className={cn(
                            "h-full rounded-full transition-all duration-700 ease-out",
                            isCurrent 
                              ? "bg-[#1A1A24]"
                              : (m.is_completed && displayPct === 100 
                                ? "bg-[#A3E635] shadow-[0_0_12px_rgba(163,230,53,0.6)]" 
                                : "bg-gradient-to-r from-[#D0B7FF] to-[#A3E635] shadow-[0_0_10px_rgba(208,183,255,0.4)]")
                          )}
                          style={{ width: `${displayPct}%` }} 
                        />
                      </div>
                      <span className={cn(
                        "text-[11px] font-bold tracking-wider shrink-0 transition-colors",
                        isCurrent ? "text-[#1A1A24]/70" : (displayPct > 0 ? "text-white/40" : "text-transparent select-none")
                      )}>
                        {Math.round(displayPct)}%
                      </span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

export default memo(LessonOverviewView);
