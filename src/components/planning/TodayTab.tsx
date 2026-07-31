/**
 * TodayTab — the day's schedule: a vertical hour axis with time blocks, a live now-line, the
 * advisory pre-mortem, and inline block controls.
 *
 * ## The two performance rules this file exists to honour
 *
 * 1. **The now-line is CSS, not JS.** It's a `.now-line` element driven by a 86400s linear
 *    keyframe with a negative delay (see `index.css`). The browser interpolates it on the
 *    compositor, so it glides at 60fps while mpv decodes video, and React re-renders zero times
 *    to keep it moving. A `setInterval` + `style={{top}}` would either jump once a second or
 *    burn a reconcile every frame.
 * 2. **No component-local clock.** Time comes from `useScheduleClock` via a `minutes` selector,
 *    so this component re-renders once a minute at most — and only this component, not its
 *    parent's subtree (the bug `PlannerTab`'s 1 Hz `setNowTick` had).
 *
 * The pre-mortem is presented as advice, never a block on saving: an ambitious plan is the
 * student's call, and a planner that refuses input is a planner that gets closed.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { gsap } from "gsap";
import {
  Anchor,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Gauge,
  Link2,
  Play,
  Plus,
  SkipForward,
  Sunrise,
  Moon,
} from "lucide-react";
import BlockModal from "./BlockModal";
import RecoveryCard from "./RecoveryCard";
import { useRecovery } from "./useRecovery";
import {
  BLOCK_STATE_META,
  blockStartMins,
  blockVisualState,
  fmtHhmmLabel,
  fmtMins,
  isBlockOpen,
} from "./planningUtils";
import { hhmmToMins, useScheduleClock } from "../../lib/scheduleClock";
import { motionAllowed } from "../../lib/perfStore";
import { cn } from "../../lib/utils";
import type { BlockStatus, DayPlan, PlanBlock } from "../../lib/types";
import type { DayPlanState } from "./useDayPlan";

const HOUR_H = 64; // px per hour, matching CalendarTimeline so the two read as one system.
/** Minimum rendered block height, so a 15-minute block is still tappable. */
const MIN_BLOCK_H = 46;

interface Props {
  schedule: DayPlanState;
}

export default function TodayTab({ schedule }: Props) {
  const { day, isToday, plan, loaded, saveBlock, removeBlock, setStatus, startBlock } = schedule;
  const navigate = useNavigate();
  // ONE subscription to the shared clock, minute-resolution. Nothing here ticks per second.
  const nowMins = useScheduleClock((s) => s.minutes);
  // Drift detection + apply/undo/dismiss. Owns its own gating; renders nothing when quiet.
  const recovery = useRecovery(schedule);

  const [modalOpen, setModalOpen] = useState(false);
  const [editBlock, setEditBlock] = useState<PlanBlock | null>(null);

  const blocks = plan?.blocks ?? [];
  const wakeMins = hhmmToMins(plan?.wake_at) ?? 6 * 60;
  const stopMins = hhmmToMins(plan?.hard_stop_at) ?? 22 * 60;

  const openBlock = (b: PlanBlock | null) => {
    setEditBlock(b);
    setModalOpen(true);
  };

  const laidOut = useMemo(() => layoutBlocks(blocks), [blocks]);
  const remaining = useMemo(
    () =>
      blocks
        .filter(isBlockOpen)
        .reduce((sum, b) => sum + Math.max(0, b.effective_mins - b.executed_mins), 0),
    [blocks],
  );

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.7fr_1fr]">
      {/* ── The day axis ── */}
      <section className="plan-panel flex min-h-[34rem] flex-col rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-5 shadow-2xl backdrop-blur-xl">
        <DayHeader schedule={schedule} onAdd={() => openBlock(null)} />

        {loaded && blocks.length === 0 ? (
          <EmptyDay isToday={isToday} onAdd={() => openBlock(null)} />
        ) : (
          <DayAxis
            day={day}
            isToday={isToday}
            nowMins={nowMins}
            wakeMins={wakeMins}
            stopMins={stopMins}
            laidOut={laidOut}
            onEdit={openBlock}
            onStart={(b) => void startBlock(b)}
            onStatus={(b, s) => void setStatus(b, s)}
            onOpenMaterial={(id) =>
              navigate(`/library/material/${id}`, { state: { source: "courses" } })
            }
          />
        )}
      </section>

      {/* ── Side rail ── */}
      <div className="flex flex-col gap-6">
        {/* Above the pre-mortem on purpose: "today is already off the rails" outranks "this plan
            was ambitious to begin with", and the card is actionable while the verdict is not. */}
        <RecoveryCard recovery={recovery} />
        <IntegrityCard plan={plan} remainingMins={remaining} />
        <UpNextCard
          blocks={blocks}
          nowMins={nowMins}
          isToday={isToday}
          onStart={(b) => void startBlock(b)}
          onEdit={openBlock}
        />
      </div>

      <BlockModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        day={day}
        block={editBlock}
        onSave={(input) => void saveBlock(input)}
        onDelete={(b) => void removeBlock(b)}
      />
    </div>
  );
}

// ── Header / navigator ───────────────────────────────────────────────────────

function DayHeader({ schedule, onAdd }: { schedule: DayPlanState; onAdd: () => void }) {
  const { day, isToday, plan, shiftDay, goToToday } = schedule;
  const label = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }, [day]);

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-content-primary">{label}</h2>
          {isToday && (
            <span className="rounded-full border border-lime/25 bg-lime/10 px-2 py-0.5 text-[0.62rem] font-semibold text-lime">
              Today
            </span>
          )}
        </div>
        {plan && (
          <p className="mt-0.5 flex items-center gap-2.5 text-[0.7rem] text-white/40">
            <span className="flex items-center gap-1">
              <Sunrise size={11} aria-hidden /> {fmtHhmmLabel(plan.wake_at)}
            </span>
            <span className="flex items-center gap-1">
              <Moon size={11} aria-hidden /> {fmtHhmmLabel(plan.hard_stop_at)}
            </span>
            <span>{fmtMins(plan.planned_mins)} planned</span>
            {plan.executed_mins > 0 && <span>{fmtMins(plan.executed_mins)} done</span>}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
          <button
            type="button"
            onClick={() => shiftDay(-1)}
            aria-label="Previous day"
            className="grid h-7 w-7 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            <ChevronLeft size={14} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            onClick={goToToday}
            className="rounded-full px-3 py-1 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => shiftDay(1)}
            aria-label="Next day"
            className="grid h-7 w-7 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            <ChevronRight size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-full bg-lime px-3.5 py-1.5 text-xs font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02]"
        >
          <Plus size={13} strokeWidth={2.5} aria-hidden />
          Block
        </button>
      </div>
    </div>
  );
}

function EmptyDay({ isToday, onAdd }: { isToday: boolean; onAdd: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <CalendarDays size={28} className="text-white/20" aria-hidden />
      <p className="text-sm text-content-secondary">
        {isToday ? "Nothing blocked out today" : "Nothing blocked out for this day"}
      </p>
      <p className="max-w-[20rem] text-xs text-white/40">
        A block is when you'll actually sit down — not just what's due. Two or three honest ones
        beat a wall of wishful hours.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-semibold text-content-primary transition-colors hover:bg-white/[0.08]"
      >
        Add the first block
      </button>
    </div>
  );
}

// ── Axis + blocks ────────────────────────────────────────────────────────────

type Laid = { block: PlanBlock; startMins: number; lane: number; laneCount: number };

/** Greedy interval partitioning — concurrent blocks sit side by side instead of overlapping. */
function layoutBlocks(blocks: PlanBlock[]): Laid[] {
  const items = blocks
    .map((block) => {
      const startMins = blockStartMins(block);
      return startMins == null ? null : { block, startMins, end: startMins + block.effective_mins };
    })
    .filter((x): x is { block: PlanBlock; startMins: number; end: number } => x != null)
    .sort((a, b) => a.startMins - b.startMins || a.end - b.end);

  const out: Laid[] = [];
  let group: (Laid & { end: number })[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;

  const flush = () => {
    const laneCount = Math.max(1, laneEnds.length);
    for (const g of group) out.push({ ...g, laneCount });
    group = [];
    laneEnds = [];
    groupEnd = -1;
  };

  for (const item of items) {
    if (groupEnd >= 0 && item.startMins >= groupEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= item.startMins);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    group.push({ block: item.block, startMins: item.startMins, lane, laneCount: 1, end: item.end });
    groupEnd = Math.max(groupEnd, item.end);
  }
  flush();
  return out;
}

function DayAxis({
  day,
  isToday,
  nowMins,
  wakeMins,
  stopMins,
  laidOut,
  onEdit,
  onStart,
  onStatus,
  onOpenMaterial,
}: {
  day: string;
  isToday: boolean;
  nowMins: number;
  wakeMins: number;
  stopMins: number;
  laidOut: Laid[];
  onEdit: (b: PlanBlock) => void;
  onStart: (b: PlanBlock) => void;
  onStatus: (b: PlanBlock, s: BlockStatus) => void;
  onOpenMaterial: (id: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Scroll to where the day actually starts (or to now), not to midnight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const focusMins = isToday ? Math.max(wakeMins, nowMins - 60) : wakeMins;
    el.scrollTop = (focusMins / 60) * HOUR_H;
    // Intentionally keyed on the day only: re-running on every minute tick would yank the
    // student's scroll position out from under them once a minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  useLayoutEffect(() => {
    if (!motionAllowed()) return;
    const ctx = gsapEntrance(rootRef.current);
    return () => ctx?.();
  }, [day, laidOut.length]);

  return (
    <div
      ref={scrollRef}
      className="scroll-thin h-full min-h-0 flex-1 overflow-y-auto rounded-[18px] border border-white/[0.06] bg-black/20"
    >
      <div ref={rootRef} className="relative" style={{ height: 24 * HOUR_H }}>
        {/* Hour gutter + rules */}
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="absolute inset-x-0 flex" style={{ top: h * HOUR_H, height: HOUR_H }}>
            <div className="w-16 shrink-0 border-r border-white/[0.05] pr-2 pt-1 text-right text-[0.62rem] text-white/30">
              {h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`}
            </div>
            <div className="flex-1 border-t border-white/[0.04]" />
          </div>
        ))}

        {/* Out-of-window shading: before wake and after the hard stop are dimmed, so an
            over-ambitious late block is visibly outside the day rather than subtly wrong. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 bg-black/25"
          style={{ height: (wakeMins / 60) * HOUR_H }}
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-x-0 bg-black/25"
          style={{ top: (stopMins / 60) * HOUR_H, bottom: 0 }}
          aria-hidden
        />

        {isToday && <NowLine nowMins={nowMins} />}

        {/* Blocks */}
        <div className="absolute inset-y-0 left-16 right-2">
          {laidOut.map(({ block, startMins, lane, laneCount }) => (
            <BlockCard
              key={block.id}
              block={block}
              top={(startMins / 60) * HOUR_H}
              height={Math.max(MIN_BLOCK_H, (block.effective_mins / 60) * HOUR_H - 4)}
              lane={lane}
              laneCount={laneCount}
              nowMins={nowMins}
              isToday={isToday}
              onEdit={onEdit}
              onStart={onStart}
              onStatus={onStatus}
              onOpenMaterial={onOpenMaterial}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The now-line. JS supplies TWO custom properties once per mount and then never touches it:
 *   * `--now-delay`  — a negative animation delay, so the 86400s sweep is already at the right
 *                      position on the first painted frame.
 *   * `--now-offset` — a static fallback position, used when animations are disabled (lite tier
 *                      / reduced motion zero out animation duration globally).
 * Remounting on the minute tick is what re-syncs it after a laptop sleeps; between ticks the
 * compositor carries it with zero JS.
 */
function NowLine({ nowMins }: { nowMins: number }) {
  const secondsToday = nowMins * 60;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-10"
      style={
        {
          "--now-delay": `-${secondsToday}s`,
          "--now-offset": `${(secondsToday / 86400) * 100}%`,
        } as CSSProperties
      }
      aria-hidden
    >
      <div className="now-line flex items-center">
        <div className="w-16" />
        <div className="relative flex-1">
          <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-lime shadow-glow-lime" />
          <div className="h-px bg-lime/60" />
        </div>
      </div>
    </div>
  );
}

function BlockCard({
  block,
  top,
  height,
  lane,
  laneCount,
  nowMins,
  isToday,
  onEdit,
  onStart,
  onStatus,
  onOpenMaterial,
}: {
  block: PlanBlock;
  top: number;
  height: number;
  lane: number;
  laneCount: number;
  nowMins: number;
  isToday: boolean;
  onEdit: (b: PlanBlock) => void;
  onStart: (b: PlanBlock) => void;
  onStatus: (b: PlanBlock, s: BlockStatus) => void;
  onOpenMaterial: (id: number) => void;
}) {
  const state = blockVisualState(block, nowMins, isToday);
  const meta = BLOCK_STATE_META[state];
  const compact = height < 74;
  const open = isBlockOpen(block);
  const endLabel = useMemo(() => {
    const s = blockStartMins(block);
    return s == null ? "" : fmtHhmmLabel(minsLabel(s + block.effective_mins));
  }, [block]);

  // Executed-vs-planned, the one number that says whether the block is actually happening.
  const progress = Math.max(0, Math.min(1, block.executed_mins / Math.max(1, block.effective_mins)));

  return (
    <div
      className={cn(
        "plan-block group/blk absolute flex flex-col overflow-hidden rounded-[12px] border border-white/[0.08] bg-gradient-to-br p-2 pl-2.5 backdrop-blur-sm transition-[transform,border-color,box-shadow] duration-200 hover:border-white/[0.18] hover:shadow-[0_10px_28px_-8px_rgba(0,0,0,0.55)]",
        meta.grad,
        state === "active" && "ring-1 ring-lime/30",
      )}
      style={{
        top,
        height,
        left: `${(lane / laneCount) * 100}%`,
        width: `calc(${100 / laneCount}% - 4px)`,
      }}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1.5 rounded-l-[12px]", meta.rail)} aria-hidden />

      <div className="flex items-start gap-1.5">
        {/* Complete / re-open. `partial` is reachable from the side rail; this is the fast path. */}
        <button
          type="button"
          onClick={() => onStatus(block, block.status === "done" ? "pending" : "done")}
          aria-label={block.status === "done" ? "Mark not done" : "Mark done"}
          className={cn(
            "z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors",
            block.status === "done"
              ? "border-emerald-400 bg-emerald-400 text-ink-900"
              : "border-white/30 text-transparent hover:border-lime/60",
          )}
        >
          <Check size={10} strokeWidth={3} aria-hidden />
        </button>

        <button
          type="button"
          onClick={() => onEdit(block)}
          aria-label={`${block.title}, ${fmtHhmmLabel(block.effective_start)} to ${endLabel}, ${meta.label}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime"
        >
          {block.is_anchored && <Anchor size={11} className="shrink-0 text-orange" aria-hidden />}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs font-semibold leading-tight",
              block.status === "done" ? "text-white/40 line-through" : "text-content-primary",
            )}
          >
            {block.title}
          </span>
        </button>

        {open && isToday && block.status !== "active" && (
          <button
            type="button"
            onClick={() => onStart(block)}
            aria-label={`Start ${block.title}`}
            className="z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-lime/30 bg-lime/10 text-lime transition-colors hover:bg-lime/20"
          >
            <Play size={10} strokeWidth={2.5} fill="currentColor" aria-hidden />
          </button>
        )}
      </div>

      {!compact && (
        <div className={cn("mt-1 flex min-w-0 items-center gap-1.5 text-[0.62rem]", meta.text)}>
          <span className="min-w-0 flex-1 truncate">
            {fmtHhmmLabel(block.effective_start)} – {endLabel} · {meta.label}
            {block.spill_count > 0 && ` · moved ${block.spill_count}×`}
          </span>
          {block.target_material_id != null && (
            <button
              type="button"
              onClick={() => onOpenMaterial(block.target_material_id as number)}
              aria-label="Open linked lesson"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-cyan-400/80 hover:bg-cyan-400/10 hover:text-cyan-300"
            >
              <Link2 size={11} strokeWidth={2} aria-hidden />
            </button>
          )}
          {open && (
            <button
              type="button"
              onClick={() => onStatus(block, "skipped")}
              aria-label={`Skip ${block.title}`}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/30 opacity-0 transition-opacity hover:bg-white/[0.08] hover:text-content-primary focus-visible:opacity-100 group-hover/blk:opacity-100"
            >
              <SkipForward size={11} strokeWidth={2} aria-hidden />
            </button>
          )}
        </div>
      )}

      {!compact && (
        <div className="mt-auto flex items-center gap-2 pt-1" title="Time actually logged against this block">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", meta.rail)}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span className={cn("shrink-0 text-[0.56rem] font-medium", meta.text)}>
            {block.executed_mins > 0 ? fmtMins(block.executed_mins) : "Not started"}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Side rail ────────────────────────────────────────────────────────────────

/**
 * The pre-mortem, stated in content terms. This is ADVICE: it never prevents saving an
 * ambitious day. The number that matters to a student isn't "integrity 47", it's "you're about
 * 90 minutes over" — so the minutes lead and the score supports.
 */
function IntegrityCard({ plan, remainingMins }: { plan: DayPlan | null; remainingMins: number }) {
  if (!plan) return null;
  const { integrity } = plan;
  const over = integrity.overcommit_mins > 0;
  const tone = over
    ? integrity.overcommit_mins > 60
      ? { ring: "border-red-400/25", bar: "bg-red-400", text: "text-red-300" }
      : { ring: "border-amber-400/25", bar: "bg-amber-400", text: "text-amber-300" }
    : { ring: "border-lime/25", bar: "bg-lime", text: "text-lime" };

  return (
    <section
      className={cn(
        "plan-panel rounded-[24px] border bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl",
        tone.ring,
      )}
    >
      <header className="mb-3 flex items-center gap-2">
        <Gauge size={16} strokeWidth={2} className={tone.text} aria-hidden />
        <h3 className="text-sm font-semibold text-content-primary">Can this day happen?</h3>
      </header>

      <p className="text-sm leading-relaxed text-content-secondary">
        {integrity.message ??
          (over
            ? `About ${fmtMins(integrity.overcommit_mins)} more than the day holds.`
            : "This plan fits the time you actually have.")}
      </p>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className={cn("h-full rounded-full", tone.bar)}
          style={{ width: `${Math.max(2, Math.min(100, Math.round(integrity.integrity)))}%` }}
        />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div>
          <dt className="text-[0.62rem] uppercase tracking-wide text-white/35">Asked for</dt>
          <dd className="mt-0.5 text-sm font-semibold text-content-primary">
            {fmtMins(integrity.demand_mins)}
          </dd>
        </div>
        <div>
          <dt className="text-[0.62rem] uppercase tracking-wide text-white/35">Realistic</dt>
          <dd className="mt-0.5 text-sm font-semibold text-content-primary">
            {fmtMins(integrity.capacity_mins)}
          </dd>
        </div>
        <div>
          <dt className="text-[0.62rem] uppercase tracking-wide text-white/35">Left</dt>
          <dd className="mt-0.5 text-sm font-semibold text-content-primary">{fmtMins(remainingMins)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-[0.66rem] leading-snug text-white/35">
        "Realistic" already allows for breaks between blocks and how long this material usually
        takes you — it isn't the raw clock.
      </p>
    </section>
  );
}

/** The single next thing, plus what follows. A whole-day list is what the axis is for. */
function UpNextCard({
  blocks,
  nowMins,
  isToday,
  onStart,
  onEdit,
}: {
  blocks: PlanBlock[];
  nowMins: number;
  isToday: boolean;
  onStart: (b: PlanBlock) => void;
  onEdit: (b: PlanBlock) => void;
}) {
  const upcoming = useMemo(() => {
    const open = blocks.filter(isBlockOpen);
    const active = open.find((b) => b.status === "active");
    const rest = open
      .filter((b) => b.status !== "active")
      .filter((b) => {
        if (!isToday) return true;
        const s = blockStartMins(b);
        return s == null || s + b.effective_mins >= nowMins;
      })
      .sort((a, b) => (blockStartMins(a) ?? 0) - (blockStartMins(b) ?? 0));
    return active ? [active, ...rest] : rest;
  }, [blocks, nowMins, isToday]);

  return (
    <section className="plan-panel rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-3 flex items-center gap-2">
        <Circle size={14} strokeWidth={2.5} className="text-cyan-400" aria-hidden />
        <h3 className="text-sm font-semibold text-content-primary">What's next</h3>
      </header>

      {upcoming.length === 0 ? (
        <p className="py-4 text-center text-xs text-white/40">
          Nothing left open — the rest of this day is settled.
        </p>
      ) : (
        <div className="-mx-1 flex flex-col">
          {upcoming.slice(0, 4).map((b) => {
            const meta = BLOCK_STATE_META[blockVisualState(b, nowMins, isToday)];
            return (
              <div key={b.id} className="flex items-center gap-3 rounded-[12px] px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => onStart(b)}
                  aria-label={`Start ${b.title}`}
                  className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors",
                    b.status === "active"
                      ? "border-lime/30 bg-lime/10 text-lime"
                      : "border-cyan-400/25 bg-cyan-400/10 text-cyan-400 hover:bg-cyan-400/20",
                  )}
                >
                  <Play size={11} strokeWidth={2.5} fill="currentColor" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(b)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm text-content-primary">{b.title}</p>
                  <p className={cn("truncate text-[0.7rem]", meta.text)}>
                    {fmtHhmmLabel(b.effective_start)} · {fmtMins(b.effective_mins)} · {meta.label}
                  </p>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minutes-since-midnight → `'HH:MM'`, clamped inside the day. */
function minsLabel(mins: number): string {
  const v = Math.max(0, Math.min(1439, Math.round(mins)));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/**
 * Block entrance stagger. The caller gates this on `motionAllowed()`, so on the lite tier (and
 * under reduced-motion) it is never invoked and blocks appear instantly — the drill/navigation
 * stagger is exactly what reads as lag on weak hardware.
 */
function gsapEntrance(root: HTMLElement | null): (() => void) | undefined {
  if (!root) return undefined;
  const targets = root.querySelectorAll(".plan-block");
  if (targets.length === 0) return undefined;
  const ctx = gsap.context(() => {
    gsap.from(targets, { opacity: 0, y: 10, duration: 0.35, ease: "power2.out", stagger: 0.04 });
  }, root);
  return () => ctx.revert();
}
