/**
 * Glass date-time picker — a friendly deadline input that matches the app's dark
 * glassmorphism (the native `<input type="datetime-local">` is ugly and breaks the DNA).
 *
 * UX (design-taste "guide the user, no spreadsheet"): quick chips first — Today,
 * Tomorrow, This weekend, Next week — each sets a sensible default time (end of day
 * 18:00). "Custom" opens a compact glass calendar popover + a time strip for the ~20%
 * of cases the chips don't cover. Emits a value the backend stores as an ISO datetime
 * string (`YYYY-MM-DD HH:MM:SS`), or null when cleared.
 *
 * Self-contained (no date library): a tiny month-grid built with the Date API.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, X, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

interface Props {
  /** Current value: ISO `YYYY-MM-DD HH:MM:SS` (or date), or null. */
  value: string | null;
  onChange: (value: string | null) => void;
}

const DEFAULT_HOUR = 18; // 6pm — a sane "end of day" default for quick chips.

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Compose an ISO datetime string the backend accepts: `YYYY-MM-DD HH:MM:SS`. */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

/** Parse a stored value into a Date (tolerates date-only + 'T' or ' ' separators). */
function parseValue(v: string | null): Date | null {
  if (!v) return null;
  const norm = v.replace(" ", "T");
  const d = new Date(norm.length <= 10 ? `${norm}T${pad(DEFAULT_HOUR)}:00:00` : norm);
  return isNaN(d.getTime()) ? null : d;
}

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export default function DateTimePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = useMemo(() => parseValue(value), [value]);
  // The month currently shown in the calendar popover.
  const [viewMonth, setViewMonth] = useState(() => selected ?? new Date());

  // Close the popover on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Set the deadline to a date at the default hour (quick chips). */
  const setQuick = (d: Date) => {
    d.setHours(DEFAULT_HOUR, 0, 0, 0);
    onChange(toIso(d));
  };

  const chips: { label: string; make: () => Date }[] = [
    { label: "Today", make: () => new Date() },
    { label: "Tomorrow", make: () => { const d = new Date(); d.setDate(d.getDate() + 1); return d; } },
    {
      label: "This weekend",
      make: () => {
        const d = new Date();
        const day = d.getDay(); // 0 Sun .. 6 Sat
        const untilSat = (6 - day + 7) % 7 || 7; // next Saturday
        d.setDate(d.getDate() + untilSat);
        return d;
      },
    },
    { label: "Next week", make: () => { const d = new Date(); d.setDate(d.getDate() + 7); return d; } },
  ];

  // Build the month grid for the popover.
  const monthCells = useMemo(() => {
    const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d));
    }
    return cells;
  }, [viewMonth]);

  const timeValue = selected ? `${pad(selected.getHours())}:${pad(selected.getMinutes())}` : `${pad(DEFAULT_HOUR)}:00`;

  const pickDay = (d: Date) => {
    const base = selected ?? new Date();
    d.setHours(base.getHours() || DEFAULT_HOUR, base.getMinutes() || 0, 0, 0);
    onChange(toIso(d));
  };

  const pickTime = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const base = selected ?? new Date();
    base.setHours(h, m, 0, 0);
    onChange(toIso(base));
  };

  const label = selected
    ? selected.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "No deadline";

  const isToday = (d: Date) => {
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  };
  const isSelected = (d: Date) =>
    selected != null &&
    d.getFullYear() === selected.getFullYear() &&
    d.getMonth() === selected.getMonth() &&
    d.getDate() === selected.getDate();

  return (
    <div ref={rootRef} className="relative">
      {/* Quick chips + current value */}
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => setQuick(c.make())}
            className="rounded-full border border-white/[0.06] bg-white/[0.03] px-2.5 py-1 text-[0.68rem] font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setViewMonth(selected ?? new Date()); setOpen((o) => !o); }}
          aria-expanded={open}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.68rem] font-medium transition-colors",
            open || selected
              ? "border-lime/30 bg-lime/10 text-lime"
              : "border-white/[0.06] bg-white/[0.03] text-content-secondary hover:bg-white/[0.06]",
          )}
        >
          <CalendarClock size={12} strokeWidth={2} aria-hidden />
          {selected ? label : "Custom"}
        </button>
        {selected && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear deadline"
            className="flex items-center gap-1 text-[0.68rem] text-white/40 hover:text-white/70"
          >
            <X size={11} strokeWidth={2} aria-hidden />
            Clear
          </button>
        )}
      </div>

      {/* Calendar + time popover */}
      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-64 rounded-[16px] border border-white/[0.08] bg-ink-850/95 p-3 shadow-2xl backdrop-blur-xl">
          {/* Month header */}
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
              aria-label="Previous month"
              className="grid h-6 w-6 place-items-center rounded-btn text-content-secondary hover:bg-white/[0.06]"
            >
              <ChevronLeft size={15} strokeWidth={2} aria-hidden />
            </button>
            <span className="text-xs font-semibold text-content-primary">
              {viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
              aria-label="Next month"
              className="grid h-6 w-6 place-items-center rounded-btn text-content-secondary hover:bg-white/[0.06]"
            >
              <ChevronRight size={15} strokeWidth={2} aria-hidden />
            </button>
          </div>

          {/* Day-of-week header */}
          <div className="mb-1 grid grid-cols-7 gap-0.5 text-center text-[0.6rem] text-white/30">
            {DOW.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>

          {/* Month grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {monthCells.map((d, i) =>
              d == null ? (
                <span key={`e${i}`} />
              ) : (
                <button
                  key={d.toISOString()}
                  type="button"
                  onClick={() => pickDay(d)}
                  className={cn(
                    "grid h-7 place-items-center rounded-btn text-[0.72rem] transition-colors",
                    isSelected(d)
                      ? "bg-lime text-ink-900 font-semibold"
                      : isToday(d)
                        ? "text-lime ring-1 ring-lime/40"
                        : "text-content-secondary hover:bg-white/[0.06]",
                  )}
                >
                  {d.getDate()}
                </button>
              ),
            )}
          </div>

          {/* Time strip */}
          <div className="mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-3">
            <span className="text-[0.68rem] text-white/40">Time</span>
            <input
              type="time"
              value={timeValue}
              onChange={(e) => pickTime(e.target.value)}
              aria-label="Deadline time"
              className="rounded-btn border border-white/[0.06] bg-black/40 px-2 py-1 text-xs text-content-primary [color-scheme:dark] focus:border-lime/30 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto rounded-btn bg-lime px-3 py-1 text-[0.68rem] font-semibold text-ink-900 transition-transform hover:scale-105"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
