/**
 * DataPrivacySheet — the in-workspace "Data & Privacy" controls (Settings.tsx stays untouched).
 *
 *   • Pause / resume tracking → `study.tracking_paused`. While paused, `log_study_session` records
 *     nothing (watch progress / resume still works — that's a separate path).
 *   • Retention → `study.retention_days`. A one-shot boot prune trims older sessions; "Forever"
 *     (the default) prunes nothing. Applied on next launch.
 *   • Clear study history → `ipc.clearStudyHistory` behind an inline confirm.
 *
 * All local-first: nothing here leaves the device.
 */

import { useEffect, useState } from "react";
import { Shield, Pause, Play, Trash2, AlertTriangle } from "lucide-react";
import Modal from "../ui/Modal";
import { ipc, isTauri } from "../../lib/ipc";
import { SETTING_TRACKING_PAUSED, SETTING_RETENTION_DAYS } from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
}

const RETENTION_OPTIONS = [
  { value: "", label: "Keep forever" },
  { value: "90", label: "3 months" },
  { value: "180", label: "6 months" },
  { value: "365", label: "1 year" },
];

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        on ? "bg-lime/80" : "bg-white/[0.12]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]",
          on ? "left-[22px]" : "left-0.5",
        )}
        aria-hidden
      />
    </button>
  );
}

export default function DataPrivacySheet({ open, onClose }: Props) {
  const [paused, setPaused] = useState(false);
  const [retention, setRetention] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !isTauri()) return;
    let alive = true;
    void Promise.all([
      ipc.getSetting(SETTING_TRACKING_PAUSED),
      ipc.getSetting(SETTING_RETENTION_DAYS),
    ]).then(([p, r]) => {
      if (!alive) return;
      setPaused(p === "true" || p === "1");
      setRetention(r && /^\d+$/.test(r) ? r : "");
    });
    // Reset the transient clear-flow state each open.
    setConfirmClear(false);
    setCleared(null);
    return () => {
      alive = false;
    };
  }, [open]);

  async function togglePause(v: boolean) {
    setPaused(v);
    if (isTauri()) await ipc.setSetting(SETTING_TRACKING_PAUSED, v ? "true" : "false");
  }
  async function changeRetention(v: string) {
    setRetention(v);
    if (isTauri()) await ipc.setSetting(SETTING_RETENTION_DAYS, v);
  }
  async function doClear() {
    setClearing(true);
    try {
      const n = isTauri() ? await ipc.clearStudyHistory() : 0;
      setCleared(n);
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Data & privacy" subtitle="Your study data stays 100% local — nothing leaves this device." widthClass="max-w-lg">
      {/* Pause tracking */}
      <div className="flex items-center justify-between gap-4 rounded-card border border-glass-border bg-white/[0.02] p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-btn border border-white/10 bg-white/[0.04] text-content-secondary">
            {paused ? <Play size={16} strokeWidth={2} aria-hidden /> : <Pause size={16} strokeWidth={2} aria-hidden />}
          </span>
          <div>
            <div className="text-sm font-medium text-content-primary">
              {paused ? "Tracking paused" : "Track study sessions"}
            </div>
            <p className="mt-0.5 text-[0.72rem] leading-snug text-white/40">
              {paused
                ? "New sessions aren't being recorded. Your existing history is safe."
                : "Records study time from the player and Pomodoro timer."}
            </p>
          </div>
        </div>
        <Switch on={!paused} onChange={(v) => togglePause(!v)} label="Track study sessions" />
      </div>

      {/* Retention */}
      <div className="mt-3 rounded-card border border-glass-border bg-white/[0.02] p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-btn border border-white/10 bg-white/[0.04] text-content-secondary">
              <Shield size={16} strokeWidth={2} aria-hidden />
            </span>
            <div>
              <div className="text-sm font-medium text-content-primary">Keep history for</div>
              <p className="mt-0.5 text-[0.72rem] leading-snug text-white/40">
                Older sessions are trimmed on the next launch. Past scores are unaffected.
              </p>
            </div>
          </div>
          <select
            value={retention}
            onChange={(e) => changeRetention(e.target.value)}
            aria-label="Data retention duration"
            className="shrink-0 rounded-btn border border-glass-border bg-ink-800 px-3 py-2 text-sm text-content-primary outline-none focus-visible:ring-2 focus-visible:ring-lime/50"
          >
            {RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Clear history */}
      <div className="mt-3 rounded-card border border-orange/20 bg-orange/[0.04] p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-btn border border-orange/30 bg-orange/10 text-orange">
            <Trash2 size={16} strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-content-primary">Clear study history</div>
            <p className="mt-0.5 text-[0.72rem] leading-snug text-white/40">
              Permanently deletes every recorded session. Courses, notes and the plan are untouched.
            </p>

            {cleared != null ? (
              <p className="mt-2 text-[0.75rem] font-medium text-lime">
                Cleared {cleared} session{cleared === 1 ? "" : "s"}.
              </p>
            ) : confirmClear ? (
              <div className="mt-3 flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-[0.75rem] font-medium text-orange">
                  <AlertTriangle size={14} strokeWidth={2.25} aria-hidden />
                  This can't be undone.
                </span>
                <button
                  type="button"
                  onClick={doClear}
                  disabled={clearing}
                  className="ml-auto rounded-btn bg-orange px-3 py-1.5 text-[0.75rem] font-semibold text-ink-900 transition-[filter] hover:brightness-110 disabled:opacity-60"
                >
                  {clearing ? "Clearing…" : "Delete all"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  disabled={clearing}
                  className="rounded-btn border border-glass-border px-3 py-1.5 text-[0.75rem] font-medium text-content-secondary hover:bg-white/[0.06]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="mt-3 rounded-btn border border-orange/30 px-3 py-1.5 text-[0.75rem] font-semibold text-orange transition-colors hover:bg-orange/10"
              >
                Clear history…
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
