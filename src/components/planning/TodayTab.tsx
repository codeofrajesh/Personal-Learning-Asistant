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
  Layers,
  Link2,
  Play,
  Plus,
  SkipForward,
  Sunrise,
  Moon,
} from "lucide-react";
import BlockModal from "./BlockModal";
import ExamsCard from "./ExamsCard";
import FocusContractPrompt from "./FocusContractPrompt";
import RecoveryCard from "./RecoveryCard";
import RoutinesModal, { RoutineSuggestion } from "./RoutinesModal";
import { useExams } from "./useExams";
import { useRecovery } from "./useRecovery";
import { useTemplates } from "./useTemplates";
import {
  BLOCK_STATE_META,
  blockDetail,
  blockProgressLabel,
  blockStartMins,
  blockVisualState,
  fmtHhmmLabel,
  fmtMins,
  isBlockOpen,
} from "./planningUtils";
import { intervalBox, layoutIntervals } from "./timelineLayout";
import { hhmmToMins, useScheduleClock } from "../../lib/scheduleClock";
import { motionAllowed } from "../../lib/perfStore";
import { cn } from "../../lib/utils";
import type { BlockStatus, DayPlan, PlanBlock, PlanTemplate } from "../../lib/types";
import type { DayPlanState } from "./useDayPlan";

const HOUR_H = 64; // px per hour, matching CalendarTimeline so the two read as one system.
/** Minimum rendered block height, so a 15-minute block is still tappable. */
const MIN_BLOCK_H = 46;
/**
 * `MIN_BLOCK_H` expressed in minutes of axis (~43 at 64px/hour).
 *
 * The layout engine has to know this: a 15-minute block is DRAWN 46px tall, so it physically
 * covers the next ~28 minutes of timeline. Without this floor the engine sees no collision
 * between back-to-back short blocks, gives both the full width and the same `left`, and they
 * render one on top of the other with their text interleaved.
 */
const MIN_BLOCK_MINS = (MIN_BLOCK_H / HOUR_H) * 60;

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
  // Routines. Loaded once here and shared with the empty-day offer and the modal.
  const templates = useTemplates();
  // Dated exams + their backward plans. Refetches on the day boundary, not on a timer.
  const exams = useExams();

  const [modalOpen, setModalOpen] = useState(false);
  const [editBlock, setEditBlock] = useState<PlanBlock | null>(null);
  const [routinesOpen, setRoutinesOpen] = useState(false);

  const blocks = plan?.blocks ?? [];
  const wakeMins = hhmmToMins(plan?.wake_at) ?? 6 * 60;
  const stopMins = hhmmToMins(plan?.hard_stop_at) ?? 22 * 60;

  const openBlock = (b: PlanBlock | null) => {
    setEditBlock(b);
    setModalOpen(true);
  };

  /**
   * Start a block AND take the student to the work.
   *
   * `startBlock` alone only flips the status, which from the student's side looks like the button
   * does nothing — the reported "dead Play button". Starting a block is a statement of intent
   * ("I am doing this now"), so the useful completion of that intent is to open what they're
   * meant to be working on:
   *
   *   * a linked lesson  → straight into the player;
   *   * a course         → that course, so they pick the next lesson themselves (we deliberately
   *                        don't auto-pick: guessing wrong wastes more time than choosing);
   *   * freeform         → nowhere to go, so stay put. The status change is the whole action, and
   *                        the block visibly turns active.
   */
  const startAndOpen = async (b: PlanBlock) => {
    await startBlock(b);
    if (b.target_material_id != null) {
      navigate(`/library/material/${b.target_material_id}`, { state: { source: "courses" } });
    } else if (b.target_node_id != null) {
      navigate(`/courses/${b.target_node_id}`);
    }
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
        <DayHeader
          schedule={schedule}
          onAdd={() => openBlock(null)}
          onRoutines={() => setRoutinesOpen(true)}
        />

        {loaded && blocks.length === 0 ? (
          <EmptyDay
            isToday={isToday}
            onAdd={() => openBlock(null)}
            suggestion={templates.suggestionFor(day)}
            onApplyRoutine={async (id) => {
              if ((await templates.apply(id, day)) > 0) await schedule.reload();
            }}
            onManageRoutines={() => setRoutinesOpen(true)}
          />
        ) : (
          <DayAxis
            day={day}
            isToday={isToday}
            nowMins={nowMins}
            wakeMins={wakeMins}
            stopMins={stopMins}
            laidOut={laidOut}
            onEdit={openBlock}
            onStart={(b) => void startAndOpen(b)}
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
          onStart={(b) => void startAndOpen(b)}
          onEdit={openBlock}
        />
        {/* Closes the loop on commitments. Necessary because `UpNextCard` lists only OPEN
            blocks: the moment a block is finished it leaves that list, taking its unanswered
            "did you keep it?" with it. */}
        {isToday && <OpenContracts blocks={blocks} />}
        {/* Last in the rail deliberately: exams are important but not immediate. Putting a
            countdown above "what do I do right now" trades action for anxiety. */}
        <ExamsCard exams={exams} />
      </div>

      <BlockModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        day={day}
        block={editBlock}
        onSave={saveBlock}
        onDelete={(b) => void removeBlock(b)}
      />

      <RoutinesModal
        open={routinesOpen}
        onClose={() => setRoutinesOpen(false)}
        day={day}
        templates={templates}
        onApplied={() => void schedule.reload()}
      />
    </div>
  );
}

// ── Header / navigator ───────────────────────────────────────────────────────

function DayHeader({
  schedule,
  onAdd,
  onRoutines,
}: {
  schedule: DayPlanState;
  onAdd: () => void;
  onRoutines: () => void;
}) {
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
        {/* Routines. Previously reachable ONLY from the empty-day offer, which made the whole
            feature invisible the moment a day had blocks — and made "save THIS day as a routine"
            unreachable by definition, since capture needs a day with blocks in it. */}
        <button
          type="button"
          onClick={onRoutines}
          aria-label="Routine days: save this day as a routine, or apply one"
          title="Routine days"
          className="flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
        >
          <Layers size={13} strokeWidth={2} aria-hidden />
          Routines
        </button>
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

/**
 * The empty day. This is where a routine earns its keep: the alternative to one tap is
 * re-entering the same five blocks by hand, which is exactly when a planner gets abandoned.
 * The routine offer leads, and building by hand stays available underneath.
 */
function EmptyDay({
  isToday,
  onAdd,
  suggestion,
  onApplyRoutine,
  onManageRoutines,
}: {
  isToday: boolean;
  onAdd: () => void;
  suggestion: PlanTemplate | null;
  onApplyRoutine: (templateId: number) => void;
  onManageRoutines: () => void;
}) {
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

      <div className="mt-3">
        <RoutineSuggestion
          template={suggestion}
          onApply={() => suggestion && onApplyRoutine(suggestion.id)}
          onManage={onManageRoutines}
        />
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="mt-1 rounded-full px-4 py-2 text-xs font-medium text-white/45 transition-colors hover:bg-white/[0.06] hover:text-content-primary"
      >
        Or add a single block
      </button>
    </div>
  );
}

// ── Axis + blocks ────────────────────────────────────────────────────────────

type Laid = { block: PlanBlock; startMins: number; col: number; span: number; cols: number };

/**
 * Place the day's blocks with the shared calendar geometry engine.
 *
 * The rank argument is the part specific to this surface: OPEN work claims the leftmost, widest
 * column, so an active block sharing a slot with a skipped or finished one is the block that
 * reads as primary. Settled work is history — it should be visible without competing.
 *
 * `MIN_BLOCK_MINS` is handed to the engine so that two short blocks scheduled minutes apart are
 * treated as colliding (because they will be drawn overlapping) and get separate columns.
 */
function layoutBlocks(blocks: PlanBlock[]): Laid[] {
  const intervals = blocks
    .map((block) => {
      const startMins = blockStartMins(block);
      if (startMins == null) return null;
      return {
        key: block.id,
        start: startMins,
        // A zero-length block would be invisible AND collide with nothing; give it a floor so it
        // still occupies the axis honestly.
        end: startMins + Math.max(1, block.effective_mins),
        rank: isBlockOpen(block) ? 0 : 1,
        block,
        startMins,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  // The rendered floor is passed in so collisions are measured in the space blocks actually
  // occupy, not the space the schedule claims. See MIN_BLOCK_MINS.
  return layoutIntervals(intervals, MIN_BLOCK_MINS).map(({ item, col, span, cols }) => ({
    block: item.block,
    startMins: item.startMins,
    col,
    span,
    cols,
  }));
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
          {laidOut.map(({ block, startMins, col, span, cols }) => (
            <BlockCard
              key={block.id}
              block={block}
              top={(startMins / 60) * HOUR_H}
              height={Math.max(MIN_BLOCK_H, (block.effective_mins / 60) * HOUR_H - 4)}
              col={col}
              span={span}
              cols={cols}
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
  col,
  span,
  cols,
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
  col: number;
  span: number;
  cols: number;
  nowMins: number;
  isToday: boolean;
  onEdit: (b: PlanBlock) => void;
  onStart: (b: PlanBlock) => void;
  onStatus: (b: PlanBlock, s: BlockStatus) => void;
  onOpenMaterial: (id: number) => void;
}) {
  const state = blockVisualState(block, nowMins, isToday);
  const meta = BLOCK_STATE_META[state];
  // Shared with CalendarTimeline: how many rows this height can hold without crushing them.
  const detail = blockDetail(height);
  const open = isBlockOpen(block);
  const endLabel = useMemo(() => {
    const s = blockStartMins(block);
    return s == null ? "" : fmtHhmmLabel(minsLabel(s + block.effective_mins));
  }, [block]);

  // Executed-vs-planned, the one number that says whether the block is actually happening.
  // A counted block fills by ITEMS instead: a "2 lessons" block that has finished one is half
  // done in the only unit the student stated, however long it happened to take.
  const counted =
    block.target_kind === "node_count" && (block.target_count ?? 0) > 0
      ? Math.min(1, Math.max(0, block.progress_count) / (block.target_count as number))
      : null;
  const progress =
    counted ?? Math.max(0, Math.min(1, block.executed_mins / Math.max(1, block.effective_mins)));
  const progressLabel = blockProgressLabel(block);
  const progressTitle =
    counted != null
      ? "Lessons finished while this block was running"
      : "Time actually logged against this block";

  // Shared geometry (see timelineLayout): a block only loses width to blocks it genuinely
  // overlaps, so a long block beside short ones no longer squeezes all of them.
  const box = intervalBox({ col, span, cols });
  // A stacked block sits ABOVE its neighbours to the left, so the layering reads as depth
  // rather than as a rendering accident. Elevation follows column order, not status.
  const z = 1 + col;

  return (
    <div
      className={cn(
        "plan-block group/blk absolute flex flex-col overflow-hidden rounded-[12px] border border-white/[0.08] bg-gradient-to-br p-2 pl-2.5 backdrop-blur-sm transition-[transform,border-color,box-shadow] duration-200 hover:border-white/[0.18] hover:shadow-[0_10px_28px_-8px_rgba(0,0,0,0.55)]",
        meta.grad,
        state === "active" && "ring-1 ring-lime/30",
        // Narrow blocks overlap their neighbour's shadow, so give them a hard edge to sit on.
        cols > 1 && "shadow-[0_4px_16px_-6px_rgba(0,0,0,0.7)]",
        // Hovering a stacked block lifts it clear of whatever is drawn over it — the standard
        // calendar affordance for reaching a partly-covered event.
        cols > 1 && "hover:z-20",
      )}
      style={{ top, height, zIndex: z, ...box }}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1.5 rounded-l-[12px]", meta.rail)} aria-hidden />

      <div className="flex shrink-0 items-start gap-1.5">
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

      {detail !== "title" && (
        <div className={cn("mt-1 flex min-w-0 shrink-0 items-center gap-1.5 text-[0.62rem]", meta.text)}>
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

      {detail === "full" && (
        <div className="mt-auto flex shrink-0 items-center gap-2 pt-1" title={progressTitle}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", meta.rail)}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          {/* The block's progress in its OWN unit ("1 / 2 lessons" for a counted block, minutes
              for a time box) rather than only elapsed minutes — a counted block that has finished
              one of two lessons was previously indistinguishable from one that had done none. */}
          <span className={cn("shrink-0 text-[0.56rem] font-medium", meta.text)}>
            {progressLabel ?? (block.executed_mins > 0 ? fmtMins(block.executed_mins) : "Not started")}
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
          {upcoming.slice(0, 4).map((b, i) => {
            const meta = BLOCK_STATE_META[blockVisualState(b, nowMins, isToday)];
            const done = blockProgressLabel(b);
            return (
              <div key={b.id} className="rounded-[12px] px-3 py-2.5">
                <div className="flex items-center gap-3">
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
                      {/* Progress in the block's own unit, so the leading card acknowledges work
                          already done instead of only naming the commitment. */}
                      {done && ` · ${done}`}
                    </p>
                  </button>
                </div>

                {/* Only on the LEADING block, and only today. Four commitment fields at once is
                    a form, not a decision — and pre-committing to a block you'll reach in six
                    hours is guessing. */}
                {i === 0 && isToday && (
                  <div className="mt-2">
                    <FocusContractPrompt block={b} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Unanswered focus contracts on finished blocks.
 *
 * This exists because "What's next" only lists OPEN blocks — the instant a block is completed it
 * leaves that list, and its unanswered "did you keep it?" would leave with it. The question is
 * the entire value of the mechanism, so it has to survive the block's own row disappearing.
 *
 * Renders nothing at all when there's nothing to answer: each child self-suppresses via
 * `askOnly`, so a settled day shows no empty card.
 */
function OpenContracts({ blocks }: { blocks: PlanBlock[] }) {
  const finished = useMemo(
    () => blocks.filter((b) => b.status === "done" || b.status === "partial"),
    [blocks],
  );
  if (finished.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {finished.map((b) => (
        <FocusContractPrompt key={b.id} block={b} askOnly showTitle />
      ))}
    </div>
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
