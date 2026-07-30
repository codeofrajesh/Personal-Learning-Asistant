/**
 * CalendarTimeline — a true calendar experience (Google-Calendar-inspired) for tasks,
 * dark-inverted into our glassmorphism DNA. A granularity switcher (Day · Month · Year)
 * plus a date navigator (‹ Today ›). Tasks are placed by their `due_at`.
 *
 *   Day   — a vertical hour axis (00–24) with positioned gradient-glass task blocks and
 *            a live "now" line; smooth vertical scroll; auto-scrolls to the workday.
 *   Month — a 7-column day grid; each day cell holds up to N task chips + "+k more";
 *            today highlighted; click a day → jump to Day view for that date.
 *   Year  — 12 mini-months; each day tinted by task density; click a month → Month view.
 *
 * Scrolling is native (`overflow-auto` + `.scroll-thin`) for smoothness at ~0 CPU
 * (no scroll-hijack). GSAP only does the block/cell entrance (reduced-motion gated).
 * Clicking any task opens the edit modal (handled by the parent via `onOpenTask`).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import { ChevronLeft, ChevronRight, Check, Link2 } from "lucide-react";
import {
  statusStyle, taskProgress, taskStatus, deadlineLabel, parseDue, isoDay, sameDay, fmtTime,
} from "./planningUtils";
import TaskGlyph from "./TaskGlyph";
import TimelineLegend from "./TimelineLegend";
import { motionAllowed } from "../../lib/perfStore";
import { cn } from "../../lib/utils";
import type { Task } from "../../lib/types";

type Grain = "day" | "month" | "year";

const HOUR_H = 64; // px per hour in Day view (roomier blocks)
const DAY_SCROLL_TO = 7; // auto-scroll Day view to ~7 AM

interface Props {
  tasks: Task[];
  now: number;
  onToggleDone: (task: Task) => void;
  onOpenTask: (task: Task) => void;
  onOpenMaterial: (id: number) => void;
}

type BlockStyle = { grad: string; rail: string; text: string; dot: string };

type LaidOutTask = {
  task: Task;
  due: Date;
  start: Date;
  startH: number;
  endH: number;
  lane: number;
  laneCount: number;
};

/** Greedy interval partitioning keeps concurrent tasks visible in side-by-side lanes. */
function layoutDayTasks(tasks: Task[]): LaidOutTask[] {
  const intervals = tasks
    .map((task) => {
      const due = parseDue(task.due_at);
      if (!due) return null;
      const mins = task.estimated_mins && task.estimated_mins > 0 ? task.estimated_mins : 60;
      const start = new Date(due.getTime() - mins * 60000);
      const endH = due.getHours() + due.getMinutes() / 60;
      return { task, due, start, startH: Math.max(0, endH - mins / 60), endH };
    })
    .filter((item): item is Omit<LaidOutTask, "lane" | "laneCount"> => item != null)
    .sort((a, b) => a.startH - b.startH || a.endH - b.endH);

  const result: LaidOutTask[] = [];
  let group: LaidOutTask[] = [];
  let groupEnd = -1;
  let laneEnds: number[] = [];
  const flush = () => {
    const laneCount = Math.max(1, laneEnds.length);
    for (const item of group) result.push({ ...item, laneCount });
    group = [];
    laneEnds = [];
    groupEnd = -1;
  };

  for (const item of intervals) {
    if (group.length > 0 && item.startH >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.startH);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = item.endH;
    groupEnd = Math.max(groupEnd, item.endH);
    group.push({ ...item, lane, laneCount: 1 });
  }
  if (group.length > 0) flush();
  return result;
}

export default function CalendarTimeline({ tasks, now, onToggleDone, onOpenTask, onOpenMaterial }: Props) {
  const [grain, setGrain] = useState<Grain>("day");
  const [cursor, setCursor] = useState(() => new Date());

  // Tasks that have a real deadline (only these appear on the calendar).
  const dated = useMemo(() => tasks.filter((t) => parseDue(t.due_at) != null), [tasks]);

  const shift = (dir: -1 | 1) => {
    setCursor((c) => {
      const d = new Date(c);
      if (grain === "day") d.setDate(d.getDate() + dir);
      else if (grain === "month") d.setFullYear(d.getFullYear(), d.getMonth() + dir, 1);
      else d.setFullYear(d.getFullYear() + dir, 0, 1);
      return d;
    });
  };

  const title = useMemo(() => {
    if (grain === "day") return cursor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (grain === "month") return cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    return String(cursor.getFullYear());
  }, [grain, cursor]);

  return (
    <div className="flex h-full flex-col">
      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCursor(new Date())}
            className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-xs font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            Today
          </button>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => shift(-1)} aria-label={`Previous ${grain}`} className="grid h-8 w-8 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06]">
              <ChevronLeft size={16} strokeWidth={2} aria-hidden />
            </button>
            <button type="button" onClick={() => shift(1)} aria-label={`Next ${grain}`} className="grid h-8 w-8 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06]">
              <ChevronRight size={16} strokeWidth={2} aria-hidden />
            </button>
          </div>
          <h3 className="min-w-0 truncate font-display text-base font-semibold text-content-primary" title={title}>{title}</h3>
        </div>

        <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
          {(["day", "month", "year"] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGrain(g)}
              aria-pressed={grain === g}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-xs font-medium capitalize transition-colors",
                grain === g
                  ? "bg-white/[0.06] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                  : "text-content-secondary hover:bg-white/[0.04]",
              )}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {grain === "day" && (
          <DayGrid cursor={cursor} now={now} tasks={dated} onToggleDone={onToggleDone} onOpenTask={onOpenTask} onOpenMaterial={onOpenMaterial} taskStyle={statusStyle} />
        )}
        {grain === "month" && (
          <MonthGrid cursor={cursor} now={now} tasks={dated} onOpenTask={onOpenTask} onJumpToDay={(d) => { setCursor(d); setGrain("day"); }} taskStyle={statusStyle} />
        )}
        {grain === "year" && (
          <YearGrid cursor={cursor} tasks={dated} onJumpToMonth={(d) => { setCursor(d); setGrain("month"); }} />
        )}

      </div>
      {grain !== "year" ? (
        <div className="mt-3 shrink-0"><TimelineLegend /></div>
      ) : (
        <p className="mt-2 shrink-0 text-right text-[0.66rem] text-content-muted">Darker cells contain more tasks.</p>
      )}
    </div>
  );
}

// ── Day view ───────────────────────────────────────────────────────────────

function DayGrid({
  cursor, now, tasks, onToggleDone, onOpenTask, onOpenMaterial, taskStyle,
}: {
  cursor: Date;
  now: number;
  tasks: Task[];
  onToggleDone: (t: Task) => void;
  onOpenTask: (t: Task) => void;
  onOpenMaterial: (id: number) => void;
  taskStyle: (t: Task, now: number) => BlockStyle;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const dayTasks = useMemo(
    () => tasks.filter((t) => { const d = parseDue(t.due_at); return d && sameDay(d, cursor); }),
    [tasks, cursor],
  );
  const laidOutTasks = useMemo(() => layoutDayTasks(dayTasks), [dayTasks]);

  // Auto-scroll to the workday on mount / day change.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = DAY_SCROLL_TO * HOUR_H;
  }, [cursor]);

  const nowDate = new Date(now);
  const showNow = sameDay(nowDate, cursor);
  const nowTop = (nowDate.getHours() + nowDate.getMinutes() / 60) * HOUR_H;

  return (
    <div ref={scrollRef} className="scroll-thin h-full overflow-y-auto rounded-[18px] border border-white/[0.06] bg-black/20">
      <div className="relative" style={{ height: 24 * HOUR_H }}>
        {/* hour lines + labels */}
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="absolute inset-x-0 flex" style={{ top: h * HOUR_H, height: HOUR_H }}>
            <div className="w-16 shrink-0 border-r border-white/[0.05] pr-2 pt-1 text-right text-[0.62rem] text-white/30">
              {h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`}
            </div>
            <div className="flex-1 border-t border-white/[0.04]" />
          </div>
        ))}

        {/* now line */}
        {showNow && (
          <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }}>
            <div className="w-16" />
            <div className="relative flex-1">
              <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-lime shadow-glow-lime" />
              <div className="h-px bg-lime/60" />
            </div>
          </div>
        )}

        {/* task blocks */}
        <div className="absolute inset-y-0 left-16 right-2">
          {laidOutTasks.map(({ task, due, start, startH, endH, lane, laneCount }) => {
            const top = startH * HOUR_H;
            const height = Math.max(44, (endH - startH) * HOUR_H - 4);
            const st = taskStyle(task, now);
            const status = taskStatus(task, now);
            const progress = taskProgress(task, now);
            const compact = height < 72;
            const relative = task.done ? "Done" : deadlineLabel(task.due_at ?? "", false, now).text;
            return (
              <div
                key={task.id}
                className={cn(
                  "group/blk absolute flex flex-col overflow-hidden rounded-[12px] border border-white/[0.08] bg-gradient-to-br p-2 pl-2.5 backdrop-blur-sm transition-all duration-200 hover:border-white/[0.18] hover:shadow-[0_10px_28px_-8px_rgba(0,0,0,0.55)]",
                  st.grad,
                )}
                style={{ top, height, left: `${(lane / laneCount) * 100}%`, width: `calc(${100 / laneCount}% - 4px)` }}
              >
                <span className={cn("absolute inset-y-0 left-0 w-1.5 rounded-l-[12px]", st.rail)} aria-hidden />

                <div className="flex items-start gap-1">
                  <button
                    type="button"
                    onClick={() => onToggleDone(task)}
                    aria-label={task.done ? "Mark not done" : "Mark done"}
                    className={cn("z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors", task.done ? "border-emerald-400 bg-emerald-400 text-ink-900" : "border-white/30 text-transparent hover:border-lime/60")}
                  >
                    <Check size={10} strokeWidth={3} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenTask(task)}
                    aria-label={`${task.title}. ${relative}. ${fmtTime(start)} to ${fmtTime(due)}.`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime"
                  >
                    <TaskGlyph task={task} size={12} className={cn("shrink-0", st.text)} />
                    <span className={cn("min-w-0 flex-1 truncate text-xs font-semibold leading-tight", task.done ? "text-white/40 line-through" : "text-content-primary")}>{task.title}</span>
                  </button>
                </div>

                {!compact && (
                  <div className={cn("mt-1 flex min-w-0 items-center gap-1 text-[0.62rem]", st.text)}>
                    <button type="button" onClick={() => onOpenTask(task)} className="min-w-0 flex-1 truncate text-left">
                      {fmtTime(start)} – {fmtTime(due)} · {relative}
                    </button>
                    {task.material_id != null && (
                      <button type="button" onClick={() => onOpenMaterial(task.material_id as number)} aria-label="Open linked lesson" className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-cyan-400/80 hover:bg-cyan-400/10 hover:text-cyan-300">
                        <Link2 size={11} strokeWidth={2} aria-hidden />
                      </button>
                    )}
                  </div>
                )}

                {!compact && (
                  <div className="mt-auto flex items-center gap-2 pt-1" title="Elapsed portion of the derived deadline window">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
                      <div
                        className={cn("h-full rounded-full transition-[width] duration-500", st.rail, status === "done" && "opacity-80")}
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                    <span className={cn("shrink-0 text-[0.56rem] font-medium", st.text)}>{status === "done" ? "Done" : "Window"}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {dayTasks.length === 0 && <p className="pointer-events-none sticky bottom-4 mx-auto -mt-12 w-fit rounded-full border border-white/[0.06] bg-ink-850/85 px-4 py-2 text-xs text-content-muted backdrop-blur-xl">No tasks due on this day.</p>}
    </div>
  );
}

// ── Month view ───────────────────────────────────────────────────────────────

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function MonthGrid({
  cursor, now, tasks, onOpenTask, onJumpToDay, taskStyle,
}: {
  cursor: Date;
  now: number;
  tasks: Task[];
  onOpenTask: (t: Task) => void;
  onJumpToDay: (d: Date) => void;
  taskStyle: (t: Task, now: number) => BlockStyle;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const arr: (Date | null)[] = [];
    for (let i = 0; i < startPad; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [cursor]);

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const d = parseDue(t.due_at);
      if (!d) continue;
      const key = isoDay(d);
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return map;
  }, [tasks]);

  useLayoutEffect(() => {
    if (!motionAllowed()) return;
    const ctx = gsap.context(() => {
      gsap.from(".cal-cell", { opacity: 0, y: 8, duration: 0.3, ease: "power2.out", stagger: 0.008 });
    }, rootRef);
    return () => ctx.revert();
  }, [cursor]);

  const today = new Date(now);

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden rounded-[18px] border border-white/[0.06] bg-black/20">
      <div className="grid grid-cols-7 border-b border-white/[0.06]">
        {DOW.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[0.62rem] font-medium uppercase tracking-wide text-white/30">{d}</div>
        ))}
      </div>
      <div className="scroll-thin grid flex-1 auto-rows-fr grid-cols-7 overflow-y-auto">
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} className="border-b border-r border-white/[0.03] bg-black/10" />;
          const key = isoDay(d);
          const dayTasks = (byDay.get(key) ?? []).sort((a, b) => (parseDue(a.due_at)?.getTime() ?? 0) - (parseDue(b.due_at)?.getTime() ?? 0) || b.priority - a.priority);
          const isToday = sameDay(d, today);
          const shown = dayTasks.slice(0, 3);
          const extra = dayTasks.length - shown.length;
          return (
            <div
              key={key}
              className="cal-cell flex min-h-[92px] flex-col gap-1 border-b border-r border-white/[0.04] p-1.5 text-left transition-colors hover:bg-white/[0.03]"
            >
              <button type="button" onClick={() => onJumpToDay(d)} aria-label={`Open ${d.toLocaleDateString()}`} className={cn("grid h-6 w-6 place-items-center rounded-full text-xs", isToday ? "bg-lime font-bold text-ink-900" : "text-content-secondary hover:bg-white/[0.06]")}>
                {d.getDate()}
              </button>
              <div className="flex flex-col gap-1">
                {shown.map((t) => {
                  const st = taskStyle(t, now);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onOpenTask(t)}
                      className={cn("flex items-center gap-1 truncate rounded-[6px] border-l-2 bg-white/[0.04] px-1.5 py-0.5 text-[0.62rem]", t.done ? "text-white/30 line-through" : "text-content-secondary", st.rail.replace("bg-", "border-"))}
                      title={t.title}
                    >
                      <TaskGlyph task={t} size={9} className={cn("shrink-0", st.text)} />
                      <span className="truncate">{t.title}</span>
                    </button>
                  );
                })}
                {extra > 0 && <button type="button" onClick={() => onJumpToDay(d)} className="w-fit rounded px-1 text-[0.6rem] text-content-muted hover:bg-white/[0.05] hover:text-content-primary">+{extra} more</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Year view ──────────────────────────────────────────────────────────────

function YearGrid({
  cursor, tasks, onJumpToMonth,
}: {
  cursor: Date;
  tasks: Task[];
  onJumpToMonth: (d: Date) => void;
}) {
  const year = cursor.getFullYear();

  const countByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      const d = parseDue(t.due_at);
      if (!d || d.getFullYear() !== year) continue;
      const key = isoDay(d);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [tasks, year]);

  const density = (n: number) => {
    if (n <= 0) return "bg-white/[0.04]";
    if (n === 1) return "bg-lime/25";
    if (n === 2) return "bg-lime/50";
    return "bg-lime";
  };

  return (
    <div className="scroll-thin grid h-full grid-cols-2 gap-4 overflow-y-auto rounded-[18px] border border-white/[0.06] bg-black/20 p-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 12 }, (_, m) => {
        const first = new Date(year, m, 1);
        const startPad = first.getDay();
        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const cells: (Date | null)[] = [];
        for (let i = 0; i < startPad; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, m, d));
        return (
          <button
            key={m}
            type="button"
            onClick={() => onJumpToMonth(new Date(year, m, 1))}
            className="flex flex-col gap-2 rounded-[14px] border border-white/[0.05] bg-white/[0.02] p-3 text-left transition-colors hover:bg-white/[0.05]"
          >
            <span className="text-xs font-semibold text-content-primary">{first.toLocaleDateString(undefined, { month: "long" })}</span>
            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((d, i) =>
                d == null ? (
                  <span key={`e${i}`} />
                ) : (
                  <span key={isoDay(d)} className={cn("aspect-square rounded-[2px]", density(countByDay.get(isoDay(d)) ?? 0))} title={`${isoDay(d)}: ${countByDay.get(isoDay(d)) ?? 0} task(s)`} />
                ),
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
