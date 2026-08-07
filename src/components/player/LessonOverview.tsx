/**
 * Lesson Overview — the right-column panel in the premium player layout.
 *
 * A rounded, opaque card with an accordion-style list of the current chapter's lessons.
 * The active lesson is highlighted with a prominent accent background. Clicking a
 * lesson navigates to that material's player route.
 *
 * Replaces the old ChapterSidebar in the player page.
 */

import { memo, useRef, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { MaterialRow } from "../../lib/types";
import { withSource, type NavSource } from "../../lib/navigation";
import { cn } from "../../lib/utils";
import { ChevronDown, ChevronUp, CheckCircle, AlertTriangle, Video, PlayCircle, Circle, AudioLines, LibraryBig, Activity, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";
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
  /** When true, the panel is rendered inside the player's tabbed right column, so it
   *  drops its own card chrome (width / margins / header) and just fills its container. */
  embedded?: boolean;
}

function LessonOverviewView({ siblings, currentId, source, embedded = false }: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [activeTab, setActiveTab] = useState<"all" | "lectures" | "notes">("all");
  const [activeFilter, setActiveFilter] = useState<"all" | "cloud" | "offline">("all");
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const filteredSiblings = useMemo(() => {
    if (!siblings) return [];
    return siblings.filter(m => {
      // 1. Tab filtering
      const videoExtensions = ["mkv", "mp4", "mov", "avi", "webm", "flv", "m4v", "wmv", "mpg", "mpeg", "3gp", "ts"];
      const isVideo = m.file_type === "VIDEO" || videoExtensions.includes(m.file_extension?.toLowerCase() || "");
      if (activeTab === "lectures" && !isVideo) return false;
      if (activeTab === "notes" && isVideo) return false;

      // 2. Cloud/Offline filtering
      if (activeFilter === "cloud" && m.source !== "telegram") return false;
      if (activeFilter === "offline" && m.source === "telegram") return false;

      return true;
    });
  }, [siblings, activeTab, activeFilter]);

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
    const targets = containerRef.current?.querySelectorAll(".expanded-stagger");
    if (!targets || targets.length === 0) return;
    gsap.fromTo(targets, 
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
      className={cn(
        "flex h-full flex-col overflow-hidden font-sans",
        embedded
          ? // Inside the tabbed right column: fill the container, glass to match the app.
            "rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-5"
          : // Standalone (non-video materials): the original light floating card.
            "w-[480px] rounded-[32px] bg-[#F4F4F6] p-7 shadow-2xl mx-6 mb-6 mt-6",
      )}
    >
      {/* Header & Filters */}
      <div className="shrink-0 pb-4 pl-2 pt-2 flex flex-col gap-4">
        <h2
          className={cn(
            "text-[24px] font-medium tracking-tight",
            embedded ? "text-content-primary" : "text-[#1A1A24]",
          )}
          title="Lesson Overview"
        >
          Lesson Overview
        </h2>

        {/* Filters Row */}
        <div className="flex items-center gap-2 pr-2 relative z-20">
          {/* Animated Tab Bar */}
          <div className={cn(
            "relative flex items-center p-0.5 rounded-full backdrop-blur-md shadow-sm border",
            embedded ? "bg-white/5 border-white/10" : "bg-black/5 border-black/10"
          )}>
            {(["all", "lectures", "notes"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "relative px-3 py-1 text-[12px] font-medium tracking-wide capitalize transition-colors duration-200 z-10 outline-none",
                  activeTab === tab 
                    ? "text-white" 
                    : (embedded ? "text-white/60 hover:text-white" : "text-black/60 hover:text-black")
                )}
              >
                {activeTab === tab && (
                  <motion.div
                    layoutId="lessonOverviewActiveTab"
                    className="absolute inset-0 bg-gradient-to-br from-blue-600/90 to-blue-400/90 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.3),_0_0_15px_rgba(59,130,246,0.5)] border border-blue-400/30"
                    initial={false}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                <span className="relative z-10 flex items-center justify-center gap-1.5 drop-shadow-sm">
                  {tab === "all" ? (
                    <LibraryBig className="w-3 h-3 drop-shadow-md" />
                  ) : tab === "lectures" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                  )}
                  {tab}
                </span>
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Filter Dropdown */}
          <div className="relative z-20">
            <button
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-all duration-300 shadow-sm border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                activeFilter !== "all"
                  ? "bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-500 border-emerald-500/30 hover:from-emerald-500/30 hover:to-teal-500/30"
                  : (embedded ? "bg-white/5 hover:bg-white/10 text-white border-white/10" : "bg-black/5 hover:bg-black/10 text-[#1A1A24] border-black/10")
              )}
            >
              <Activity className="w-3 h-3" />
              {activeFilter === "all" ? "All Sources" : activeFilter === "cloud" ? "Cloud Only" : "Offline Only"}
              <ChevronRight className={cn("w-3 h-3 transition-transform duration-200", isFilterOpen && "rotate-90")} />
            </button>
            
            {/* Dropdown Menu */}
            {isFilterOpen && (
              <div className={cn(
                "absolute right-0 top-full mt-2 w-36 origin-top-right rounded-xl border p-1 shadow-2xl backdrop-blur-xl z-[60]",
                embedded ? "bg-[#1C1C20]/95 border-white/10" : "bg-white border-black/10"
              )}>
                {(["all", "cloud", "offline"] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => {
                      setActiveFilter(opt);
                      setIsFilterOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                      activeFilter === opt 
                        ? (embedded ? "bg-white/10 text-white" : "bg-black/5 text-black")
                        : (embedded ? "text-content-secondary hover:bg-white/5 hover:text-content-primary" : "text-black/60 hover:bg-black/5 hover:text-black")
                    )}
                  >
                    <span className={cn(
                      "capitalize font-['Outfit'] tracking-wide",
                      activeFilter === opt
                        ? (embedded ? "font-bold text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "font-bold text-emerald-600 drop-shadow-[0_0_8px_rgba(52,211,153,0.4)]")
                        : "font-medium"
                    )}>
                      {opt === "all" ? "All Sources" : opt}
                    </span>
                    {activeFilter === opt && <CheckCircle className={cn("h-3.5 w-3.5", embedded ? "text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "text-emerald-600 drop-shadow-[0_0_8px_rgba(52,211,153,0.4)]")} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Lesson list */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-2">
        <ul className="flex flex-col gap-4 pb-4">
          {filteredSiblings.map((m, i) => {
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
