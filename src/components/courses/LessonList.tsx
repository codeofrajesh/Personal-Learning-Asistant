/**
 * The lesson list inside a folder, in whatever order the student wants it.
 *
 * A course rarely arrives in the order it should be studied — "Lecture 10" sorts before
 * "Lecture 2", and a Telegram import lands in message order regardless of what the channel
 * called things. So the list carries its own order, and dragging is how you set it.
 *
 * **Custom is the resting state, not a mode you switch into.** A folder starts out alphabetical
 * because nothing has been arranged yet (the backend keeps `sort_order = 0` until a drag), and
 * the first drop is what makes the order the student's. The A–Z control is therefore a *reset*
 * offered after arranging, not a rival mode — one order, one source of truth, no hidden second
 * arrangement to be surprised by later.
 *
 * Motion: framer-motion's `Reorder` handles the drag physics and the layout springs. The one
 * GSAP touch is the drop confirmation — a short pulse down the row that just landed, which is
 * the moment the student needs told "that's saved" without a toast interrupting them.
 */

import { useEffect, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  ArrowDownAZ,
  Bookmark,
  Check,
  ChevronRight,
  File as FileLucide,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  GripVertical,
  Loader2,
  Trash2,
} from "lucide-react";
import type { MaterialRow as MaterialRowData } from "../../lib/types";
import { motionAllowed } from "../../lib/perfStore";
import { cn } from "../../lib/utils";

gsap.registerPlugin(useGSAP);

const FILE_ICON: Record<string, typeof FileLucide> = {
  video: FileVideo,
  pdf: FileText,
  note: FileText,
  image: FileImage,
  audio: FileAudio,
};

/** How the saved order is doing. `saving` and `failed` are the only ones that show. */
type SaveState = "idle" | "saving" | "saved" | "failed";

interface LessonListProps {
  lessons: MaterialRowData[];
  /** True when a filter is hiding rows — dragging a partial list would write a partial order. */
  isFiltered: boolean;
  /** Persist the new full order. Rejects if the write failed. */
  onReorder: (orderedIds: number[]) => Promise<void>;
  /** Sort the folder back to A–Z and save that as the order. */
  onSortAlphabetical: () => Promise<void>;
  onOpen: (lesson: MaterialRowData) => void;
  onToggleBookmark: (lesson: MaterialRowData) => void;
  onDelete: (lesson: MaterialRowData) => void;
}

export default function LessonList({
  lessons,
  isFiltered,
  onReorder,
  onSortAlphabetical,
  onOpen,
  onToggleBookmark,
  onDelete,
}: LessonListProps) {
  // The list is driven locally while dragging so the rows follow the pointer without waiting on
  // a round trip, then reconciled from props once the write lands.
  const [order, setOrder] = useState(lessons);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  /** The row to flash after a drop. The counter forces a re-run when the same row moves twice. */
  const [justMoved, setJustMoved] = useState<{ id: number; nonce: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const nonceRef = useRef(0);
  // `onDragEnd` fires from inside framer-motion's gesture, so it reads the arrangement here
  // rather than from a render closure that may predate the last `onReorder`.
  const orderRef = useRef(order);
  orderRef.current = order;

  // Follow the server list, except mid-drag — replacing the array under the pointer would make
  // the row being held snap back to where it started.
  useEffect(() => {
    if (draggingRef.current) return;
    setOrder(lessons);
  }, [lessons]);

  // Confirm the drop where it happened. A toast for something the student just did with their
  // own hand is noise; a pulse on the row they moved is the same information in place.
  useGSAP(
    () => {
      if (justMoved == null || !motionAllowed()) return;
      const row = rootRef.current?.querySelector(`[data-lesson-id="${justMoved.id}"]`);
      if (!row) return;
      gsap.fromTo(
        row,
        { backgroundColor: "rgba(34,211,238,0.10)" },
        {
          backgroundColor: "rgba(34,211,238,0)",
          duration: 0.9,
          ease: "power2.out",
          clearProps: "backgroundColor",
        },
      );
    },
    { dependencies: [justMoved], scope: rootRef },
  );

  // 1-based landing spot of the row that just moved, for the live region.
  const movedPosition = (() => {
    if (justMoved == null) return null;
    const at = order.findIndex((l) => l.id === justMoved.id);
    return at < 0 ? null : at + 1;
  })();

  const persist = async (next: MaterialRowData[], movedId: number) => {
    setSaveState("saving");
    try {
      await onReorder(next.map((l) => l.id));
      setSaveState("saved");
      nonceRef.current += 1;
      setJustMoved({ id: movedId, nonce: nonceRef.current });
    } catch {
      // Put the list back where the server still thinks it is, rather than showing an order
      // that won't survive a refresh.
      setOrder(lessons);
      setSaveState("failed");
    }
  };

  const handleDragEnd = (lesson: MaterialRowData) => {
    draggingRef.current = false;
    // `orderRef` already holds the arrangement the drag produced.
    void persist(orderRef.current, lesson.id);
  };

  /**
   * Move a lesson one step with the keyboard.
   *
   * Dragging is unusable without a pointer, and a course list is exactly the kind of thing
   * someone reorders in bulk, so the same operation is on the arrow keys.
   */
  const nudge = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    void persist(next, next[target].id);
  };

  return (
    <div ref={rootRef}>
      {/* Order bar — states the current arrangement and offers the one alternative. */}
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <p className="flex items-center gap-2 text-xs text-content-faint">
          {isFiltered ? (
            <>
              <span className="text-content-muted">Filtered view</span>
              <span aria-hidden className="text-white/20">
                ·
              </span>
              <span>clear the filter to rearrange</span>
            </>
          ) : (
            <>
              <GripVertical size={13} strokeWidth={2} aria-hidden className="text-white/25" />
              Drag a lesson to set the order
            </>
          )}
          {saveState === "saving" && (
            <span className="ml-1 inline-flex items-center gap-1 text-content-muted">
              <Loader2 size={11} strokeWidth={2.5} className="animate-spin" aria-hidden />
              Saving
            </span>
          )}
        </p>

        <button
          type="button"
          onClick={() => void onSortAlphabetical()}
          disabled={isFiltered || saveState === "saving"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-content-secondary transition-all hover:border-white/20 hover:bg-white/[0.06] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40",
            (isFiltered || saveState === "saving") && "cursor-not-allowed opacity-40",
          )}
        >
          <ArrowDownAZ size={13} strokeWidth={2} aria-hidden />
          Sort A–Z
        </button>
      </div>

      {saveState === "failed" && (
        <p
          role="alert"
          className="mb-3 rounded-xl border border-orange/25 bg-orange/10 px-4 py-2.5 text-xs text-orange"
        >
          That order didn't save. The list is back to its last saved arrangement — try again.
        </p>
      )}

      {isFiltered ? (
        <div className="flex flex-col gap-2.5">
          {order.map((lesson, i) => (
            <LessonRow
              key={lesson.id}
              lesson={lesson}
              idxLabel={String(i + 1).padStart(2, "0")}
              draggable={false}
              onOpen={() => onOpen(lesson)}
              onToggleBookmark={() => onToggleBookmark(lesson)}
              onDelete={() => onDelete(lesson)}
            />
          ))}
        </div>
      ) : (
        <Reorder.Group
          axis="y"
          values={order}
          onReorder={setOrder}
          className="flex list-none flex-col"
        >
          {order.map((lesson, i) => (
            <DraggableLesson
              key={lesson.id}
              lesson={lesson}
              idxLabel={String(i + 1).padStart(2, "0")}
              isFirst={i === 0}
              isLast={i === order.length - 1}
              onDragStart={() => {
                draggingRef.current = true;
              }}
              onDragEnd={() => handleDragEnd(lesson)}
              onNudge={(direction) => nudge(i, direction)}
              onOpen={() => onOpen(lesson)}
              onToggleBookmark={() => onToggleBookmark(lesson)}
              onDelete={() => onDelete(lesson)}
            />
          ))}
        </Reorder.Group>
      )}
      {/* Screen readers get the outcome, since the visual pulse can't reach them. Announcing the
          landing position rather than a bare "saved" both carries more and differs between moves,
          so consecutive nudges each announce instead of collapsing into one. */}
      <p className="sr-only" role="status" aria-live="polite">
        {saveState === "saved" && movedPosition != null
          ? `Moved to position ${movedPosition} of ${order.length}.`
          : ""}
      </p>
    </div>
  );
}

function DraggableLesson({
  lesson,
  idxLabel,
  isFirst,
  isLast,
  onDragStart,
  onDragEnd,
  onNudge,
  onOpen,
  onToggleBookmark,
  onDelete,
}: {
  lesson: MaterialRowData;
  idxLabel: string;
  isFirst: boolean;
  isLast: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onNudge: (direction: -1 | 1) => void;
  onOpen: () => void;
  onToggleBookmark: () => void;
  onDelete: () => void;
}) {
  const controls = useDragControls();
  const [isDragging, setIsDragging] = useState(false);

  return (
    <Reorder.Item
      value={lesson}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => {
        setIsDragging(true);
        onDragStart();
      }}
      onDragEnd={() => {
        setIsDragging(false);
        onDragEnd();
      }}
      // A gentle spring on settle — heavy enough to feel like the row has weight, quick enough
      // not to hold up the next drag.
      transition={{ type: "spring", stiffness: 550, damping: 42 }}
      className={cn("list-none pb-2.5", isDragging && "relative z-20")}
    >
      <LessonRow
        lesson={lesson}
        idxLabel={idxLabel}
        draggable
        isDragging={isDragging}
        isFirst={isFirst}
        isLast={isLast}
        onGrab={(e) => controls.start(e)}
        onNudge={onNudge}
        onOpen={onOpen}
        onToggleBookmark={onToggleBookmark}
        onDelete={onDelete}
      />
    </Reorder.Item>
  );
}

/**
 * One lesson row: drag handle · numbered circle · title + metadata · bookmark · delete · status.
 *
 * Kept visually identical to the pre-drag row apart from the handle, which only materialises on
 * hover or focus — the list is for watching lessons far more often than for rearranging them.
 */
function LessonRow({
  lesson,
  idxLabel,
  draggable,
  isDragging = false,
  isFirst = false,
  isLast = false,
  onGrab,
  onNudge,
  onOpen,
  onToggleBookmark,
  onDelete,
}: {
  lesson: MaterialRowData;
  idxLabel: string;
  draggable: boolean;
  isDragging?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  onGrab?: (e: React.PointerEvent) => void;
  onNudge?: (direction: -1 | 1) => void;
  onOpen: () => void;
  onToggleBookmark: () => void;
  onDelete: () => void;
}) {
  const missing = lesson.status === "missing";
  const done = lesson.is_completed;
  const dur = lesson.duration_secs;
  const durLabel = dur != null && dur > 0 ? formatShortDuration(dur) : null;
  const inLabel = lesson.progress_pct > 0 && !done ? `${lesson.progress_pct}% in` : null;
  const FileIcon = FILE_ICON[lesson.file_type] ?? FileLucide;

  return (
    <div
      data-lesson-id={lesson.id}
      className={cn(
        "lesson-row group flex items-center gap-2 rounded-lg border-b border-white/[0.04] bg-transparent px-1 py-4 transition-all duration-300 hover:border-white/[0.05] hover:bg-gradient-to-r hover:from-white/[0.06] hover:to-transparent hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
        missing && "opacity-60",
        isDragging &&
          "border-white/10 bg-gradient-to-r from-white/[0.09] to-white/[0.02] shadow-[0_18px_40px_-16px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,255,255,0.08)]",
      )}
    >
      {/* Drag handle. Its own control rather than the whole row: a row you can drag is a row you
          can't scroll past on a touchpad without moving something by accident. */}
      {draggable ? (
        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            onGrab?.(e);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onNudge?.(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onNudge?.(1);
            }
          }}
          aria-label={`Reorder ${lesson.file_name}. Use the up and down arrow keys to move it.`}
          aria-disabled={isFirst && isLast}
          className={cn(
            "grid h-8 w-6 shrink-0 cursor-grab touch-none place-items-center rounded text-white/20 opacity-0 transition-all duration-200 hover:text-white/60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/50 group-hover:opacity-100 active:cursor-grabbing",
            isDragging && "cursor-grabbing text-cyan-400 opacity-100",
          )}
        >
          <GripVertical size={15} strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <span className="w-6 shrink-0" aria-hidden />
      )}

      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        aria-label={`Play lesson: ${lesson.file_name}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 rounded outline-none focus-visible:ring-1 focus-visible:ring-white/30"
      >
        {/* Numbered circle — 3D tactile, identical for every row; cyan accent on hover */}
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.15] bg-gradient-to-b from-white/[0.12] to-white/[0.02] font-medium text-white/70 shadow-[inset_0_1px_2px_rgba(255,255,255,0.2)] transition-all duration-300 group-hover:border-cyan-400/40 group-hover:text-cyan-400 group-hover:shadow-[inset_0_1px_3px_rgba(34,211,238,0.35)]"
        >
          {idxLabel}
        </span>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-sm font-medium",
              missing ? "text-content-muted" : "text-content-primary",
            )}
          >
            {lesson.file_name}
            {missing && <span className="ml-1.5 text-xs text-orange-400/80">· file missing</span>}
          </p>
          <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-content-muted">
            <FileIcon
              size={12}
              strokeWidth={2}
              aria-hidden
              className="shrink-0 text-content-muted"
            />
            {durLabel && <span>{durLabel}</span>}
            {durLabel && inLabel && (
              <span aria-hidden className="text-white/20">
                ·
              </span>
            )}
            {inLabel && <span className="text-content-secondary">{inLabel}</span>}
          </p>
        </div>
      </div>

      {/* Bookmark — faint gray default, solid lime only when active */}
      <button
        type="button"
        onClick={onToggleBookmark}
        aria-label={lesson.is_bookmarked ? "Remove bookmark" : "Bookmark lesson"}
        aria-pressed={lesson.is_bookmarked}
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-btn transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
          lesson.is_bookmarked
            ? "text-lime hover:bg-lime/10"
            : "text-white/30 hover:bg-white/[0.05] hover:text-white/50",
        )}
      >
        <Bookmark
          size={16}
          strokeWidth={2}
          fill={lesson.is_bookmarked ? "currentColor" : "none"}
          aria-hidden
        />
      </button>

      {/* Delete — hover-revealed trash, so it never gets in the way of the row's
          play/bookmark actions. */}
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete lesson: ${lesson.file_name}`}
        title="Delete lesson"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-btn text-white/25 opacity-0 transition-all duration-200 hover:bg-orange/15 hover:text-orange focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange/40 group-hover:opacity-100"
      >
        <Trash2 size={16} strokeWidth={2} aria-hidden />
      </button>

      {/* Status: subtle-green ✔ Done, or muted-cyan Start › */}
      {done ? (
        <span className="flex shrink-0 items-center gap-1 pr-2 text-xs font-semibold text-lime/70">
          <Check size={14} strokeWidth={3} aria-hidden />
          Done
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 pr-2 text-xs font-semibold text-cyan-400/90">
          Start
          <ChevronRight size={13} strokeWidth={2.5} aria-hidden />
        </span>
      )}
    </div>
  );
}

/** Seconds → `H:MM:SS` / `M:SS`. */
function formatShortDuration(secs: number): string {
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
