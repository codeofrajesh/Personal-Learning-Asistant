/**
 * TargetSettings — configure daily study ambition and Path B weekly/monthly active rhythm.
 *
 * Mathematical Logic & Constraint Architecture:
 *   • Daily Target D (hours/day).
 *   • Weekly Cap = D × 7. Weekly hours W cannot exceed D × 7.
 *   • Weekly active days W_days = round(W / D), rest days = 7 - W_days.
 *   • Monthly Cap = round(W × 30 / 7). Monthly hours M cannot exceed round(W × 30 / 7).
 *   • Monthly active days M_days = round(W_days / 7 × 30), rest days = 30 - M_days.
 *   • Strict mathematical parity: rest day ratio in week always matches rest days in month.
 */

import { useEffect, useState } from "react";
import { Target, CalendarRange, CalendarDays, Lock, RotateCcw } from "lucide-react";
import Modal from "../ui/Modal";
import { fmtHM } from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
  targetMins: number | null;
  weeklyDays?: number;
  monthlyDays?: number | null;
  onSave: (dailyMins: number | null, weeklyDays?: number, monthlyDays?: number | null) => Promise<void> | void;
}

const DAILY_PRESETS = [2, 4, 6, 7, 8];

export default function TargetSettings({
  open,
  onClose,
  targetMins,
  weeklyDays = 7,
  monthlyDays = null,
  onSave,
}: Props) {
  const [dailyHoursStr, setDailyHoursStr] = useState<string>("2");
  const [weeklyHoursStr, setWeeklyHoursStr] = useState<string>("14");
  const [monthlyHoursStr, setMonthlyHoursStr] = useState<string>("60");
  const [isMonthlyAuto, setIsMonthlyAuto] = useState<boolean>(true);

  // Parse daily
  const parsedDaily = parseFloat(dailyHoursStr);
  const validDaily = Number.isFinite(parsedDaily) && parsedDaily >= 0.25 && parsedDaily <= 16;
  const safeDaily = validDaily ? parsedDaily : 2;

  // Strict Week Math
  const maxWeeklyHours = Math.round(safeDaily * 7 * 10) / 10;
  const parsedWeekly = parseFloat(weeklyHoursStr);
  const safeWeekly = Number.isFinite(parsedWeekly)
    ? Math.min(maxWeeklyHours, Math.max(safeDaily, parsedWeekly))
    : maxWeeklyHours;
  const weeklyStudyDays = Math.min(7, Math.max(1, Math.round(safeWeekly / safeDaily)));
  const weeklyRestDays = 7 - weeklyStudyDays;
  const weeklyCapacityPct = Math.min(100, Math.round((safeWeekly / maxWeeklyHours) * 100));

  // Strict Month Math (30-day standard)
  // Mathematical monthly study days is strictly derived from weekly active days ratio:
  const monthlyStudyDays = Math.min(30, Math.max(1, Math.round((weeklyStudyDays / 7) * 30)));
  const monthlyRestDays = 30 - monthlyStudyDays;
  const maxMonthlyAllowedFromWeek = Math.round(monthlyStudyDays * safeDaily * 10) / 10;

  const parsedMonthly = parseFloat(monthlyHoursStr);
  const safeMonthly = isMonthlyAuto
    ? maxMonthlyAllowedFromWeek
    : Number.isFinite(parsedMonthly)
      ? Math.min(maxMonthlyAllowedFromWeek, Math.max(safeDaily, parsedMonthly))
      : maxMonthlyAllowedFromWeek;
  const monthlyCapacityPct = Math.min(100, Math.round((safeMonthly / Math.max(0.1, safeDaily * 30)) * 100));

  // Sync inputs on open
  useEffect(() => {
    if (open) {
      const initialDaily = targetMins ? targetMins / 60 : 2;
      const initialWeeklyDays = weeklyDays >= 1 && weeklyDays <= 7 ? weeklyDays : 7;
      const initialWeeklyHours = Math.min(initialDaily * 7, initialDaily * initialWeeklyDays);
      const initialMonthlyDays = Math.min(30, Math.round((initialWeeklyDays / 7) * 30));
      const initialMonthlyHours = Math.round(initialMonthlyDays * initialDaily * 10) / 10;

      setDailyHoursStr(String(+initialDaily.toFixed(2)));
      setWeeklyHoursStr(String(+initialWeeklyHours.toFixed(1)));
      setMonthlyHoursStr(String(+initialMonthlyHours.toFixed(1)));
      setIsMonthlyAuto(true);
    }
  }, [open, targetMins, weeklyDays, monthlyDays]);

  // When daily changes, update weekly and monthly caps
  function handleDailyChange(val: string) {
    setDailyHoursStr(val);
    const p = parseFloat(val);
    if (Number.isFinite(p) && p >= 0.25) {
      const newMaxW = Math.round(p * weeklyStudyDays * 10) / 10;
      setWeeklyHoursStr(String(newMaxW));
      const mDays = Math.min(30, Math.max(1, Math.round((weeklyStudyDays / 7) * 30)));
      const newM = Math.round(mDays * p * 10) / 10;
      setMonthlyHoursStr(String(newM));
    }
  }

  // When weekly days preset or pills are clicked
  function setWeeklyDaysPreset(days: number) {
    const clamped = Math.max(1, Math.min(7, days));
    const newWeeklyH = Math.min(maxWeeklyHours, Math.round(safeDaily * clamped * 10) / 10);
    setWeeklyHoursStr(String(newWeeklyH));
    const mDays = Math.min(30, Math.max(1, Math.round((clamped / 7) * 30)));
    const newM = Math.round(mDays * safeDaily * 10) / 10;
    setMonthlyHoursStr(String(newM));
  }

  // When weekly hours custom input changes
  function handleWeeklyHoursChange(val: string) {
    setWeeklyHoursStr(val);
    const p = parseFloat(val);
    if (Number.isFinite(p)) {
      const clamped = Math.min(maxWeeklyHours, Math.max(0.5, p));
      const days = Math.min(7, Math.max(1, Math.round(clamped / safeDaily)));
      const mDays = Math.min(30, Math.max(1, Math.round((days / 7) * 30)));
      const newM = Math.round(mDays * safeDaily * 10) / 10;
      setMonthlyHoursStr(String(newM));
    }
  }

  // When monthly hours custom input changes
  function handleMonthlyHoursChange(val: string) {
    setIsMonthlyAuto(false);
    setMonthlyHoursStr(val);
  }

  function handleResetSync() {
    setIsMonthlyAuto(true);
    setMonthlyHoursStr(String(maxMonthlyAllowedFromWeek));
  }

  async function handleSave() {
    if (!validDaily) return;
    const dailyMins = Math.round(safeDaily * 60);
    const saveMonthlyDays = isMonthlyAuto ? null : monthlyStudyDays;
    await onSave(dailyMins, weeklyStudyDays, saveMonthlyDays);
    onClose();
  }

  async function handleClear() {
    await onSave(null, 7, null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Study Targets & Active Rhythm"
      subtitle="Daily ambition and weekly/monthly pacing with strict rest balance."
      widthClass="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={handleClear}
            className="mr-auto rounded-btn border border-glass-border px-3.5 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-btn border border-glass-border px-3.5 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!validDaily}
            className="rounded-btn bg-lime px-4 py-1.5 text-xs font-semibold text-ink-900 shadow-glow-lime transition-[filter] hover:brightness-110 disabled:pointer-events-none disabled:opacity-50"
          >
            Save targets
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        {/* ── 1. Daily Ambition ────────────────────────────────────────────── */}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-lime/30 bg-lime/10 text-lime">
                <Target size={16} strokeWidth={2} />
              </span>
              <span className="text-xs font-semibold text-content-primary">Daily Target</span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0.25}
                max={16}
                step={0.5}
                value={dailyHoursStr}
                onChange={(e) => handleDailyChange(e.target.value)}
                className="w-16 rounded-lg border border-lime/30 bg-white/[0.04] px-2 py-1 text-center text-sm font-bold tabular-nums text-content-primary outline-none focus-visible:ring-1 focus-visible:ring-lime"
              />
              <span className="text-xs text-content-muted">h/day</span>
            </div>
          </div>

          {/* Presets */}
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-[0.65rem] uppercase tracking-wider text-white/40 mr-1">Presets:</span>
            {DAILY_PRESETS.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => handleDailyChange(String(h))}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[0.7rem] font-medium transition-colors",
                  validDaily && Math.abs(parsedDaily - h) < 0.05
                    ? "border-lime/40 bg-lime/15 text-lime font-semibold"
                    : "border-glass-border text-content-secondary hover:bg-white/[0.05]",
                )}
              >
                {h}h
              </button>
            ))}
          </div>
        </div>

        {/* ── 2. Weekly Study Rhythm (Path B) ─────────────────────────────── */}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-400">
                <CalendarRange size={16} strokeWidth={2} />
              </span>
              <div>
                <span className="text-xs font-semibold text-content-primary">Weekly Rhythm</span>
                <span className="ml-2 text-[0.68rem] text-content-muted">
                  {weeklyStudyDays} active · {weeklyRestDays} rest
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={safeDaily}
                max={maxWeeklyHours}
                step={0.5}
                value={weeklyHoursStr}
                onChange={(e) => handleWeeklyHoursChange(e.target.value)}
                className="w-16 rounded-lg border border-blue-500/30 bg-white/[0.04] px-2 py-1 text-center text-sm font-bold tabular-nums text-content-primary outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
              />
              <span className="text-xs text-content-muted">h/wk</span>
            </div>
          </div>

          {/* Quick presets & active days selector */}
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {[
                { days: 5, label: "5d (Weekdays)" },
                { days: 6, label: "6d (Dedicated)" },
                { days: 7, label: "7d (Relentless)" },
              ].map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => setWeeklyDaysPreset(p.days)}
                  className={cn(
                    "rounded-lg border px-2 py-1 text-[0.68rem] font-medium transition-colors",
                    weeklyStudyDays === p.days
                      ? "border-blue-500/50 bg-blue-500/20 text-blue-200 font-semibold"
                      : "border-white/[0.06] text-content-secondary hover:bg-white/[0.04]",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setWeeklyDaysPreset(d)}
                  className={cn(
                    "h-6 w-6 rounded-md text-[0.68rem] font-bold transition-colors",
                    weeklyStudyDays === d
                      ? "bg-blue-500 text-white shadow-sm"
                      : "border border-white/[0.08] text-white/50 hover:bg-white/[0.06]",
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Strict Ceiling Constraint Badge */}
          <div className="mt-2.5 flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-2.5 py-1.5 text-[0.7rem]">
            <div className="flex items-center gap-1.5 text-amber-300">
              <Lock size={12} />
              <span>Cap: Max {maxWeeklyHours}h/wk (7d × {safeDaily}h)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-amber-400 transition-all duration-300"
                  style={{ width: `${weeklyCapacityPct}%` }}
                />
              </div>
              <span className="font-semibold tabular-nums text-amber-200">{weeklyCapacityPct}%</span>
            </div>
          </div>
        </div>

        {/* ── 3. Monthly Study Rhythm (Mathematically Bound to Week) ───────── */}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-400">
                <CalendarDays size={16} strokeWidth={2} />
              </span>
              <div>
                <span className="text-xs font-semibold text-content-primary">Monthly Rhythm</span>
                <span className="ml-2 text-[0.68rem] text-content-muted">
                  {monthlyStudyDays} active · {monthlyRestDays} rest
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={safeDaily}
                max={maxMonthlyAllowedFromWeek}
                step={1}
                value={monthlyHoursStr}
                onChange={(e) => handleMonthlyHoursChange(e.target.value)}
                className="w-16 rounded-lg border border-purple-500/30 bg-white/[0.04] px-2 py-1 text-center text-sm font-bold tabular-nums text-content-primary outline-none focus-visible:ring-1 focus-visible:ring-purple-400"
              />
              <span className="text-xs text-content-muted">h/mo</span>
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between">
            <button
              type="button"
              onClick={handleResetSync}
              className={cn(
                "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[0.68rem] transition-colors",
                isMonthlyAuto
                  ? "border-purple-500/40 bg-purple-500/15 text-purple-200 font-semibold"
                  : "border-white/[0.06] text-content-secondary hover:bg-white/[0.04]",
              )}
            >
              <RotateCcw size={10} />
              Auto-proportional to week ({monthlyStudyDays} active · {monthlyRestDays} rest)
            </button>
            <span className="text-[0.68rem] text-content-muted">
              Rest parity: {weeklyRestDays}/7d = {monthlyRestDays}/30d
            </span>
          </div>

          {/* Strict Ceiling Constraint Badge */}
          <div className="mt-2.5 flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/[0.05] px-2.5 py-1.5 text-[0.7rem]">
            <div className="flex items-center gap-1.5 text-amber-300">
              <Lock size={12} />
              <span>Cap: Max {maxMonthlyAllowedFromWeek}h/mo (bound to {safeWeekly}h/wk)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-amber-400 transition-all duration-300"
                  style={{ width: `${monthlyCapacityPct}%` }}
                />
              </div>
              <span className="font-semibold tabular-nums text-amber-200">{monthlyCapacityPct}%</span>
            </div>
          </div>
        </div>

        {/* ── 4. Clean 3-Column Summary Strip ─────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-glass-border bg-white/[0.02] p-2">
            <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-lime/80">Daily</div>
            <div className="mt-0.5 text-xs font-bold text-content-primary tabular-nums">
              {safeDaily}h <span className="text-[0.65rem] font-normal text-content-muted">/ day</span>
            </div>
            <div className="text-[0.62rem] text-content-muted">{fmtHM(safeDaily * 60)}</div>
          </div>

          <div className="rounded-lg border border-glass-border bg-white/[0.02] p-2">
            <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-blue-400/80">Weekly</div>
            <div className="mt-0.5 text-xs font-bold text-content-primary tabular-nums">
              {safeWeekly}h <span className="text-[0.65rem] font-normal text-content-muted">/ wk</span>
            </div>
            <div className="text-[0.62rem] text-content-muted">{weeklyStudyDays}d active · {weeklyRestDays}d rest</div>
          </div>

          <div className="rounded-lg border border-glass-border bg-white/[0.02] p-2">
            <div className="text-[0.6rem] font-semibold uppercase tracking-wider text-purple-400/80">Monthly</div>
            <div className="mt-0.5 text-xs font-bold text-content-primary tabular-nums">
              {safeMonthly}h <span className="text-[0.65rem] font-normal text-content-muted">/ mo</span>
            </div>
            <div className="text-[0.62rem] text-content-muted">{monthlyStudyDays}d active · {monthlyRestDays}d rest</div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
