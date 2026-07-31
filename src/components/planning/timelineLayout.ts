/**
 * Timeline collision layout — the geometry engine shared by the Today axis and the Calendar
 * Day view.
 *
 * ## Why this file exists
 *
 * Both surfaces previously carried their own near-identical "greedy lane partitioning" pass, and
 * both had the same architectural flaw: every block in a collision group was given
 * `1 / laneCount` of the width. Lanes were counted per *group*, and a group grew as long as any
 * member's end pushed past the next member's start — so ONE long block dragged everything it
 * touched into the same divisor. A 6:00–12:00 study block next to three unrelated 30-minute
 * blocks rendered all four at 25% width, none of which actually overlap each other. That is the
 * "cramped and visually messy" report: the squeeze was not caused by the blocks that collide, it
 * was caused by blocks that merely share a cluster.
 *
 * Real calendars (Google, Apple, Fantastical) solve this in two passes, and so does this module:
 *
 *   1. **Column assignment** — inside a cluster of transitively-overlapping items, each item
 *      takes the leftmost column that is free at its start time. This is the part the old code
 *      had.
 *   2. **Column-span expansion** — each item then GROWS rightward across adjacent columns for as
 *      long as nothing in those columns overlaps it. This is the part the old code was missing,
 *      and it is what stops non-overlapping neighbours from stealing width. The long block above
 *      keeps one column; each short block spans the remaining columns and renders nearly
 *      full-width.
 *
 * The result degrades gracefully: with no collisions every item spans every column and is
 * full-width, which is the common case and the one that must look calm.
 *
 * ## Geometry, not appearance
 *
 * This module returns column indices and spans — plain numbers. It deliberately knows nothing
 * about px, gradients or status colours, so the two surfaces can render the same geometry with
 * their own vocabulary and the algorithm stays unit-testable.
 *
 * Intervals are HALF-OPEN, matching the backend's overlap rule (`db::plan::find_conflict`): a
 * block ending at 12:00 and one starting at 12:00 are neighbours, not collisions. Keeping the
 * two definitions identical is what stops the UI from drawing an overlap the backend would have
 * refused to save.
 */

/** One thing to place on a timeline. `start`/`end` are minutes from midnight (`end` exclusive). */
export interface TimelineInterval {
  /** Stable identity, used only to keep the sort deterministic. */
  key: number | string;
  start: number;
  end: number;
  /**
   * Tie-break rank among items starting at the same minute; LOWER sorts first and so wins the
   * leftmost, widest column. The Today axis passes 0 for open work and 1 for settled work, so an
   * active block placed in the same slot as a skipped one gets the primary column rather than
   * whichever the sort happened to reach first — the exact case in the bug report.
   */
  rank?: number;
}

/** Where one interval sits: column `col` of `cols`, occupying `span` columns. */
export interface PlacedInterval<T extends TimelineInterval> {
  item: T;
  col: number;
  span: number;
  cols: number;
}

/**
 * Assign every interval a column, a span, and its cluster's column count.
 *
 * O(n²) in the worst case *within a single cluster*, and clusters are small by construction (a
 * day holds a handful of blocks). Sorting dominates in practice.
 */
export function layoutIntervals<T extends TimelineInterval>(items: T[]): PlacedInterval<T>[] {
  const sorted = [...items]
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end))
    .sort(
      (a, b) =>
        a.start - b.start ||
        (a.rank ?? 0) - (b.rank ?? 0) ||
        // Longer first among equals: the item that constrains the cluster most should anchor
        // column 0, so short items are the ones that get to span.
        b.end - a.end ||
        String(a.key).localeCompare(String(b.key)),
    );

  const out: PlacedInterval<T>[] = [];

  // ── Pass 1: clusters + column assignment ───────────────────────────────────
  type Slot = { item: T; col: number };
  let cluster: Slot[] = [];
  /** Last end time per column, for "is this column free at `start`?". */
  let columnEnds: number[] = [];
  /** Furthest end seen in the cluster — the cluster is over once an item starts at/after it. */
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;
    const cols = Math.max(1, columnEnds.length);
    for (const slot of cluster) {
      out.push({ item: slot.item, col: slot.col, span: expand(slot, cluster, cols), cols });
    }
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    // Half-open: starting exactly when the cluster ends begins a new, independent cluster.
    if (item.start >= clusterEnd) flush();

    let col = columnEnds.findIndex((end) => end <= item.start);
    if (col === -1) col = columnEnds.length;
    columnEnds[col] = item.end;

    cluster.push({ item, col });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();

  return out;
}

/**
 * How many columns `slot` can occupy before it would sit on top of something.
 *
 * Grows rightward one column at a time and stops at the first column containing an interval that
 * genuinely overlaps this one. Stopping at the FIRST blocked column (rather than skipping it) is
 * deliberate: a block must stay a contiguous rectangle, because a split one reads as two blocks.
 */
function expand<T extends TimelineInterval>(
  slot: { item: T; col: number },
  cluster: { item: T; col: number }[],
  cols: number,
): number {
  let span = 1;
  for (let next = slot.col + 1; next < cols; next++) {
    const blocked = cluster.some(
      (other) =>
        other.col === next &&
        other.item.key !== slot.item.key &&
        overlaps(other.item, slot.item),
    );
    if (blocked) break;
    span++;
  }
  return span;
}

/** Half-open overlap test, matching the backend's rule. */
function overlaps(a: TimelineInterval, b: TimelineInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Horizontal CSS for a placed interval, as a percentage box with a gutter between neighbours.
 *
 * `calc()` keeps the gutter a fixed pixel value while the box stays fluid — a percentage gutter
 * would shrink to nothing at 4 columns, exactly when separation matters most. The last column in
 * a row loses no width to a gutter it doesn't need.
 */
export function intervalBox(
  placed: { col: number; span: number; cols: number },
  gutterPx = 4,
): { left: string; width: string } {
  const { col, span, cols } = placed;
  const leftPct = (col / cols) * 100;
  const widthPct = (span / cols) * 100;
  const isLast = col + span >= cols;
  return {
    left: `${leftPct}%`,
    // Indent every column but the first so overlapping work reads as layered rather than merely
    // adjacent, the way a real calendar stacks concurrent events.
    width: isLast ? `calc(${widthPct}% - ${col > 0 ? gutterPx : 0}px)` : `calc(${widthPct}% - ${gutterPx}px)`,
  };
}
