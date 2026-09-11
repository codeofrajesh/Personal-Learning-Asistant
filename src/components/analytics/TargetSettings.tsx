/**
 * TargetSettings — set the daily study ambition (e.g. 7h/day).
 *
 * Writes the SHARED `study.daily_goal_mins` setting (via `useTargetSetting.save`), the same key the
 * sidebar Study Meter falls back to on unplanned days. This never overrides a planned schedule:
 * `study_meter` always prefers the plan when a day has blocks, so a target only fills the gap on
 * days you didn't plan. Weekly / monthly figures are auto-derived (×7 / ×30), not stored separately.
 */

import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import Modal from "../ui/Modal";
import { fmtHM } from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  targetMins: number | null;
  onSave: (mins: number | null) => Promise<void> | void;
}

const PRESETS = [2, 4, 6, 7, 8]; // hours

export default function TargetSettings({ open, onClose, targetMins, onSave }: Props) {
  const [hours, setHours] = useState<string>("");

  // Sync the input to the current target each time the sheet opens.
  useEffect(() => {
    if (open) setHours(targetMins ? String(+(targetMins / 60).toFixed(2)) : "");
  }, [open, targetMins]);

  const parsed = parseFloat(hours);
  const valid = Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 16;
  const mins = valid ? Math.round(parsed * 60) : null;

  async function save() {
    if (!valid) return;
    await onSave(mins);
    onClose();
  }
  async function clear() {
    await onSave(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Daily study target"
      subtitle="Your ambition per day — planned schedules always take priority over this."
      widthClass="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={clear}
            className="mr-auto rounded-btn border border-glass-border px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            Clear target
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-btn border border-glass-border px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!valid}
            className="rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-[filter] hover:brightness-110 disabled:pointer-events-none disabled:opacity-50"
          >
            Save target
          </button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-card border border-lime/25 bg-lime/10 text-lime">
          <Target size={20} strokeWidth={2} aria-hidden />
        </span>
        <div className="flex items-end gap-2">
          <input
            type="number"
            min={0.25}
            max={16}
            step={0.5}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            aria-label="Daily target in hours"
            className="w-24 rounded-btn border border-glass-border bg-white/[0.03] px-3 py-2 text-2xl font-bold tabular-nums text-content-primary outline-none focus-visible:ring-2 focus-visible:ring-lime/50"
          />
          <span className="pb-2 text-sm text-content-muted">hours / day</span>
        </div>
      </div>

      {/* Presets */}
      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map((h) => {
          const active = valid && mins === h * 60;
          return (
            <button
              key={h}
              type="button"
              onClick={() => setHours(String(h))}
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                active
                  ? "border-lime/40 bg-lime/15 text-lime"
                  : "border-glass-border text-content-secondary hover:bg-white/[0.05]",
              )}
            >
              {h}h
            </button>
          );
        })}
      </div>

      {/* Auto-suggested weekly / monthly */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-card border border-glass-border bg-white/[0.02] p-3">
          <div className="text-[0.6rem] font-medium uppercase tracking-wide text-white/40">Weekly</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-content-primary">
            {mins ? fmtHM(mins * 7) : "—"}
          </div>
        </div>
        <div className="rounded-card border border-glass-border bg-white/[0.02] p-3">
          <div className="text-[0.6rem] font-medium uppercase tracking-wide text-white/40">Monthly</div>
          <div className="mt-1 text-lg font-bold tabular-nums text-content-primary">
            {mins ? fmtHM(mins * 30) : "—"}
          </div>
        </div>
      </div>

      <p className="mt-4 rounded-card border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-[0.75rem] leading-relaxed text-white/45">
        On days you plan a schedule in Planning, your goal is the sum of those blocks — this target
        only applies to days you haven't planned. Build up gradually; a sustainable 6–8h beats a
        heroic day followed by burnout.
      </p>
    </Modal>
  );
}
