/**
 * PeriodPicker — a sleek pop-up for jumping to any period in Compare mode, instead of spamming the
 * `<`/`>` steppers. Built on the shared accessible `Modal` (Esc-closes, focus-trapped). The picker
 * adapts to the active granularity:
 *
 *   • month — a year header (‹ 2026 ›) + a 12-month grid; jump to any month in one click.
 *   • week  — a scrollable list of recent weeks with clear date ranges.
 *   • day   — a browsable mini-calendar; click any exact day.
 *
 * Plus quick preset chips. Everything resolves to a compare index (0 = current, negative = past),
 * so it plugs straight into the existing index-based compare state. Future periods are disabled.
 *
 * The stateful body is a child of `Modal`, which only renders children while open — so the browsed
 * year/month resets to the current selection each time the popup opens.
 */

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Modal from "../ui/Modal";
import {
  comparePeriod,
  monthGridOf,
  monthOffset,
  dayOffsetIndex,
  parseLocalDay,
  type Granularity,
} from "./analyticsUtils";
import { localDay } from "../../lib/scheduleClock";
import { useRetentionSetting } from "./useStudyAnalytics";
import { cn } from "../../lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  gran: Granularity;
  today: string;
  currentIndex: number;
  onSelect: (index: number) => void;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

const TITLE: Record<Granularity, string> = {
  day: "Pick a day",
  week: "Pick a week",
  month: "Pick a month",
};

export default function PeriodPicker({ open, onClose, gran, today, currentIndex, onSelect }: Props) {
  function choose(index: number) {
    onSelect(index);
    onClose();
  }
  return (
    <Modal open={open} onClose={onClose} title={TITLE[gran]} widthClass="max-w-md">
      <PickerBody gran={gran} today={today} currentIndex={currentIndex} onChoose={choose} />
    </Modal>
  );
}

function Presets({ items, current, onChoose }: { items: { label: string; index: number }[]; current: number; onChoose: (i: number) => void }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {items.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => onChoose(p.index)}
          className={cn(
            "rounded-full border px-3 py-1 text-[0.72rem] font-medium transition-colors",
            p.index === current
              ? "border-lime/40 bg-lime/15 text-lime"
              : "border-glass-border text-content-secondary hover:bg-white/[0.05]",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function PickerBody({
  gran,
  today,
  currentIndex,
  onChoose,
}: {
  gran: Granularity;
  today: string;
  currentIndex: number;
  onChoose: (index: number) => void;
}) {
  const base = parseLocalDay(today);
  const { earliestDate } = useRetentionSetting();

  if (gran === "month") {
    // The month currently selected (for highlight + initial browse year).
    const sel = new Date(base.getFullYear(), base.getMonth() + currentIndex, 1);
    return (
      <MonthPicker
        today={today}
        baseYear={base.getFullYear()}
        selYear={sel.getFullYear()}
        selMonth={sel.getMonth()}
        currentIndex={currentIndex}
        earliestDate={earliestDate}
        onChoose={onChoose}
      />
    );
  }

  if (gran === "week") {
    const allWeeks = Array.from({ length: 26 }, (_, i) => -i).map((k) => ({ k, p: comparePeriod("week", k, today) }));
    const weeks = earliestDate
      ? allWeeks.filter(({ p }) => p.end >= earliestDate)
      : allWeeks;

    return (
      <>
        <Presets
          current={currentIndex}
          onChoose={onChoose}
          items={[
            { label: "This week", index: 0 },
            { label: "Last week", index: -1 },
            { label: "4 weeks ago", index: -4 },
          ].filter((p) => !earliestDate || comparePeriod("week", p.index, today).end >= earliestDate)}
        />
        <div className="scroll-thin max-h-72 space-y-1 overflow-y-auto pr-1">
          {weeks.map(({ k, p }) => (
            <button
              key={k}
              type="button"
              onClick={() => onChoose(k)}
              className={cn(
                "flex w-full items-center justify-between rounded-btn border px-3 py-2 text-left transition-colors",
                k === currentIndex ? "border-lime/40 bg-lime/10" : "border-glass-border hover:bg-white/[0.05]",
              )}
            >
              <span className="text-sm font-medium text-content-primary">{p.label}</span>
              <span className="text-[0.72rem] tabular-nums text-white/40">{p.sub}</span>
            </button>
          ))}
        </div>
      </>
    );
  }

  // day
  const selDate = comparePeriod("day", currentIndex, today).start;
  const sel = parseLocalDay(selDate);
  return (
    <DayPicker
      today={today}
      initYear={sel.getFullYear()}
      initMonth={sel.getMonth()}
      selDate={selDate}
      currentIndex={currentIndex}
      earliestDate={earliestDate}
      onChoose={onChoose}
    />
  );
}

function MonthPicker({
  today,
  selYear,
  selMonth,
  currentIndex,
  earliestDate,
  onChoose,
}: {
  today: string;
  baseYear: number;
  selYear: number;
  selMonth: number;
  currentIndex: number;
  earliestDate?: string | null;
  onChoose: (i: number) => void;
}) {
  const [viewYear, setViewYear] = useState(selYear);
  const nowYear = parseLocalDay(today).getFullYear();
  const minYear = earliestDate ? parseLocalDay(earliestDate).getFullYear() : nowYear - 4;

  return (
    <>
      <Presets
        current={currentIndex}
        onChoose={onChoose}
        items={[
          { label: "This month", index: 0 },
          { label: "Last month", index: -1 },
          { label: "Same month last year", index: -12 },
        ].filter((p) => {
          if (!earliestDate) return true;
          const cp = comparePeriod("month", p.index, today);
          return cp.end >= earliestDate;
        })}
      />
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setViewYear((y) => Math.max(minYear, y - 1))}
          disabled={viewYear <= minYear}
          aria-label="Previous year"
          className="grid h-8 w-8 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-25"
        >
          <ChevronLeft size={18} aria-hidden />
        </button>
        <span className="text-sm font-semibold tabular-nums text-content-primary">{viewYear}</span>
        <button
          type="button"
          onClick={() => setViewYear((y) => Math.min(nowYear, y + 1))}
          disabled={viewYear >= nowYear}
          aria-label="Next year"
          className="grid h-8 w-8 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-30"
        >
          <ChevronRight size={18} aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {MONTH_ABBR.map((mn, m) => {
          const idx = monthOffset(viewYear, m, today);
          const future = idx > 0;
          const monthEnd = localDay(new Date(viewYear, m + 1, 0));
          const isTooOld = earliestDate != null && monthEnd < earliestDate;
          const disabled = future || isTooOld;
          const active = idx === currentIndex;
          const isSel = viewYear === selYear && m === selMonth;
          return (
            <button
              key={mn}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(idx)}
              className={cn(
                "rounded-btn border py-2.5 text-sm font-medium transition-colors",
                active || isSel ? "border-lime/40 bg-lime/15 text-lime" : "border-glass-border text-content-secondary hover:bg-white/[0.05]",
                disabled && "pointer-events-none opacity-25",
              )}
            >
              {mn}
            </button>
          );
        })}
      </div>
    </>
  );
}

function DayPicker({
  today,
  initYear,
  initMonth,
  selDate,
  currentIndex,
  earliestDate,
  onChoose,
}: {
  today: string;
  initYear: number;
  initMonth: number;
  selDate: string;
  currentIndex: number;
  earliestDate?: string | null;
  onChoose: (i: number) => void;
}) {
  const [ym, setYm] = useState({ y: initYear, m: initMonth });
  const grid = monthGridOf(ym.y, ym.m);
  const now = parseLocalDay(today);
  const atCurrentMonth = ym.y > now.getFullYear() || (ym.y === now.getFullYear() && ym.m >= now.getMonth());

  const monthLastDay = localDay(new Date(ym.y, ym.m + 1, 0));
  const cannotGoPrev = earliestDate != null && monthLastDay <= earliestDate;

  const step = (delta: number) => setYm(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  return (
    <>
      <Presets
        current={currentIndex}
        onChoose={onChoose}
        items={[
          { label: "Today", index: 0 },
          { label: "Yesterday", index: -1 },
          { label: "A week ago", index: -7 },
        ].filter((p) => {
          if (!earliestDate) return true;
          const cp = comparePeriod("day", p.index, today);
          return cp.start >= earliestDate;
        })}
      />
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={cannotGoPrev}
          aria-label="Previous month"
          className="grid h-8 w-8 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-25"
        >
          <ChevronLeft size={18} aria-hidden />
        </button>
        <span className="text-sm font-semibold text-content-primary">{grid.label}</span>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={atCurrentMonth}
          aria-label="Next month"
          className="grid h-8 w-8 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-30"
        >
          <ChevronRight size={18} aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w, i) => (
          <div key={`h${i}`} className="pb-1 text-center text-[0.55rem] font-medium text-white/25">
            {w}
          </div>
        ))}
        {Array.from({ length: grid.leading }).map((_, i) => (
          <div key={`pad${i}`} aria-hidden />
        ))}
        {grid.days.map(({ date, dom }) => {
          const idx = dayOffsetIndex(date, today);
          const future = idx > 0;
          const isTooOld = earliestDate != null && date < earliestDate;
          const disabled = future || isTooOld;
          const active = date === selDate;
          return (
            <button
              key={date}
              type="button"
              disabled={disabled}
              onClick={() => onChoose(idx)}
              className={cn(
                "grid aspect-square place-items-center rounded-[9px] border text-[0.72rem] font-medium tabular-nums transition-colors",
                active
                  ? "border-lime/50 bg-lime/15 text-lime"
                  : "border-transparent text-content-secondary hover:border-glass-border hover:bg-white/[0.05]",
                disabled && "pointer-events-none opacity-20",
              )}
            >
              {dom}
            </button>
          );
        })}
      </div>
    </>
  );
}
