/**
 * Settings — Section 8, Page 7 (+ Section 10 Data & Backup).
 *
 * Six sections, each a glass panel: Manage Folders, Default Player, Theme, Data
 * Management, Keyboard Shortcuts, About. Folder/player/theme state is persisted to the
 * `settings` table + `registered_dirs`; export/backup/import use the native dialog
 * plugin. Honest empty states throughout (no folders yet → composed prompt; light theme
 * → "coming soon" since only dark is styled for now).
 *
 * The page is a single file with small internal section components for cohesion; each
 * section owns its own load/act state so one failing action doesn't block the others.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Eye, EyeOff, ArrowUp, ArrowDown, Timer, Coffee, Moon, RotateCcw,
  Folder, Palette, Play, Database, Info, DownloadCloud,
} from "lucide-react";
import Breadcrumb from "../components/layout/Breadcrumb";
import { useTimerStore, TIMER_DEFAULTS, type Phase } from "../lib/timerStore";
import { useMaterialManager } from "../lib/materialManagerStore";
import {
  ipc,
  isTauri,
  NotInTauriError,
  openFileDialog,
  saveDialog,
} from "../lib/ipc";
import {
  defaultLayout,
  loadLayout,
  saveLayout,
  widgetMeta,
  type DashboardLayout,
} from "../lib/dashboardLayout";
import type { ImportSummary, RegisteredDir } from "../lib/types";

// ── Shared bits ──────────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass rounded-card p-card shadow-card">
      <header className="mb-4">
        <h2 className="text-base font-semibold text-content-primary">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-content-muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

function errMsg(e: unknown): string {
  return e instanceof NotInTauriError ? e.message : e instanceof Error ? e.message : String(e);
}

function StatusBadge({ status }: { status: string }) {
  const ok = status === "done";
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[0.7rem] font-medium " +
        (ok ? "bg-lime/15 text-lime" : "bg-orange/15 text-orange")
      }
    >
      {ok ? "✓ scanned" : status}
    </span>
  );
}

// ── Manage Folders ───────────────────────────────────────────────────────────

function ManageFolders() {
  const [dirs, setDirs] = useState<RegisteredDir[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const openAddFolder = useMaterialManager((s) => s.openAddFolder);
  const importNonce = useMaterialManager((s) => s.importNonce);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setDirs(await ipc.listRegisteredDirs());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch the registered-folder list after a global Add-Folder import.
  useEffect(() => {
    if (importNonce > 0) void load();
  }, [importNonce, load]);

  const remove = async (id: number) => {
    setBusyId(id);
    try {
      await ipc.removeRegisteredDir(id);
      await load();
      setNote("Folder unregistered. Its materials stay in your library.");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const rescan = async (id: number) => {
    setBusyId(id);
    setNote(null);
    try {
      const counts = await ipc.rescanFolder(id);
      await load();
      setNote(`Rescan complete — ${counts.materials_imported} files, ${counts.chapters_created} chapters.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section
      title="Manage Folders"
      description="Folders PLE scans for learning material. Removing unregisters a folder; its imported materials stay."
    >
      {loading && <p className="text-sm text-content-muted">Loading…</p>}
      {error && <p className="text-sm text-orange">Couldn’t load folders: {error}</p>}

      {!loading && dirs.length === 0 && !error && (
        <div className="rounded-btn bg-white/[0.03] p-4 text-center text-sm text-content-muted">
          No folders registered yet. Click “Add Folder” to import your first one.
        </div>
      )}

      {dirs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {dirs.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-3 rounded-btn bg-white/[0.03] px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-content-primary" title={d.path}>
                  {d.path}
                </p>
                <p className="mt-0.5 truncate text-xs text-content-muted">
                  {d.root_name ?? "—"}
                  {d.last_scanned_at && ` · scanned ${d.last_scanned_at.slice(0, 16).replace("T", " ")}`}
                </p>
              </div>
              <StatusBadge status={d.scan_status} />
              <button
                type="button"
                onClick={() => void rescan(d.id)}
                disabled={busyId === d.id}
                className="rounded-btn border border-white/10 px-2.5 py-1 text-xs text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-50"
              >
                {busyId === d.id ? "…" : "Rescan"}
              </button>
              <button
                type="button"
                onClick={() => void remove(d.id)}
                disabled={busyId === d.id}
                className="rounded-btn border border-orange/30 px-2.5 py-1 text-xs text-orange transition-colors hover:bg-orange/10 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {note && <p className="mt-3 text-xs text-lime">{note}</p>}

      <button
        type="button"
        onClick={openAddFolder}
        className="mt-4 rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02]"
      >
        ➕ Add Folder
      </button>
    </Section>
  );
}

// ── Default Player ───────────────────────────────────────────────────────────

const PLAYER_KEY = "player.engine";
const PLAYER_OPTIONS = [
  { value: "mpv", label: "Native (libmpv) — plays MKV/HEVC in-app", hint: "Recommended" },
  { value: "html5", label: "Built-in (HTML5) — MP4/WebM only", hint: "Fallback" },
] as const;

function DefaultPlayer() {
  const [value, setValue] = useState<string>("mpv");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    void ipc.getSetting(PLAYER_KEY).then((v) => {
      if (v === "mpv" || v === "html5") setValue(v);
      setLoaded(true);
    });
  }, []);

  const choose = async (v: string) => {
    setValue(v);
    try {
      await ipc.setSetting(PLAYER_KEY, v);
    } catch {
      /* keep the optimistic UI; setting is non-critical */
    }
  };

  return (
    <Section
      title="Default Player"
      description="The in-app video engine. Native (libmpv) decodes MKV and HEVC that the built-in HTML5 player can't. If the native engine fails to start, it falls back to the built-in automatically. The 'Open in system player' button (in the player toolbar) always hands a file to your OS default app (VLC / mpv / Windows Media)."
    >
      <div className="flex flex-col gap-2">
        {PLAYER_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-center gap-3 rounded-btn bg-white/[0.03] px-3 py-2.5 text-sm transition-colors hover:bg-white/[0.05]"
          >
            <input
              type="radio"
              name="player"
              value={opt.value}
              checked={value === opt.value}
              onChange={() => void choose(opt.value)}
              disabled={!loaded}
              className="accent-lime"
            />
            <span className={value === opt.value ? "text-content-primary" : "text-content-secondary"}>
              {opt.label}
            </span>
            <span className="ml-auto text-[0.7rem] text-content-faint">{opt.hint}</span>
          </label>
        ))}
      </div>
    </Section>
  );
}

// ── Theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = "theme";
const THEME_OPTIONS = [
  { value: "dark", label: "Dark", disabled: false },
  { value: "light", label: "Light", disabled: true },
] as const;

function Theme() {
  const [value, setValue] = useState<string>("dark");

  useEffect(() => {
    if (!isTauri()) return;
    void ipc.getSetting(THEME_KEY).then((v) => {
      if (v) setValue(v);
    });
  }, []);

  const choose = async (v: string) => {
    if (v === value) return;
    setValue(v);
    try {
      await ipc.setSetting(THEME_KEY, v);
    } catch {
      /* non-critical */
    }
  };

  return (
    <Section title="Theme" description="Dark is the default. Light theme is a future release.">
      <div className="flex gap-2">
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => void choose(opt.value)}
            disabled={opt.disabled}
            className={
              "flex-1 rounded-btn border px-4 py-2.5 text-sm font-medium transition-colors " +
              (value === opt.value && !opt.disabled
                ? "border-lime/40 bg-lime/10 text-lime"
                : "border-white/10 text-content-secondary hover:bg-white/[0.05]") +
              (opt.disabled ? " cursor-not-allowed opacity-50" : "")
            }
            title={opt.disabled ? "Coming soon" : undefined}
          >
            {opt.label}
            {opt.disabled && <span className="ml-1.5 text-[0.7rem] text-content-faint">soon</span>}
          </button>
        ))}
      </div>
    </Section>
  );
}

// ── Data Management ──────────────────────────────────────────────────────────

function DataManagement() {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportData = async () => {
    setBusy("export");
    setError(null);
    setNote(null);
    try {
      const path = await saveDialog("ple-export.json", ["json"]);
      if (!path) return;
      await ipc.exportDataToFile(path);
      setNote(`Exported to ${path}`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const backup = async () => {
    setBusy("backup");
    setError(null);
    setNote(null);
    try {
      const path = await saveDialog("ple-backup.db", ["db"]);
      if (!path) return;
      await ipc.backupDatabase(path);
      setNote(`Database backed up to ${path}`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const importData = async () => {
    setBusy("import");
    setError(null);
    setNote(null);
    try {
      const path = await openFileDialog(["json"]);
      if (!path) return;
      const counts: ImportSummary = await ipc.importDataFromFile(path);
      setNote(
        `Imported ${counts.goals} goals, ${counts.subjects} subjects, ${counts.chapters} chapters, ${counts.materials} materials.`,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const btn =
    "rounded-btn border border-white/10 px-4 py-2 text-sm text-content-secondary transition-colors hover:bg-white/[0.05] disabled:opacity-50";

  return (
    <Section
      title="Data Management"
      description="Everything stays local. Export a portable JSON, back up the raw database, or merge an export back in."
    >
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void exportData()} disabled={!!busy} className={btn}>
          {busy === "export" ? "Exporting…" : "⬇ Export Progress (JSON)"}
        </button>
        <button type="button" onClick={() => void backup()} disabled={!!busy} className={btn}>
          {busy === "backup" ? "Backing up…" : "⬇ Backup Database"}
        </button>
        <button type="button" onClick={() => void importData()} disabled={!!busy} className={btn}>
          {busy === "import" ? "Importing…" : "⬆ Import Data"}
        </button>
      </div>
      {note && <p className="mt-3 text-xs text-lime">{note}</p>}
      {error && <p className="mt-3 text-xs text-orange">{error}</p>}
    </Section>
  );
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────────────

const SHORTCUTS: { keys: string; action: string; scope: string }[] = [
  { keys: "Ctrl K", action: "Open search", scope: "Anywhere" },
  { keys: "Ctrl B", action: "Toggle sidebar", scope: "Anywhere" },
  { keys: "Esc", action: "Close modal / search", scope: "Anywhere" },
  { keys: "Space", action: "Play / pause", scope: "Player" },
  { keys: "← / →", action: "Seek −10s / +10s", scope: "Player" },
  { keys: "↑ / ↓", action: "Volume up / down", scope: "Player" },
  { keys: "F", action: "Toggle fullscreen", scope: "Player" },
  { keys: "M", action: "Mark current material complete", scope: "Player" },
  { keys: "N / P", action: "Next / previous lesson", scope: "Player" },
];

function Shortcuts() {
  return (
    <Section title="Keyboard Shortcuts" description="Reference card for the built-in shortcuts.">
      <ul className="flex flex-col divide-y divide-white/[0.05]">
        {SHORTCUTS.map((s) => (
          <li key={s.keys} className="flex items-center gap-3 py-2 text-sm">
            <kbd className="rounded border border-glass-border px-2 py-0.5 font-mono text-xs text-content-secondary">
              {s.keys}
            </kbd>
            <span className="flex-1 text-content-primary">{s.action}</span>
            <span className="text-[0.7rem] text-content-faint">{s.scope}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── About ────────────────────────────────────────────────────────────────────

function About() {
  return (
    <Section title="About">
      <div className="flex items-center gap-4">
        <span className="grid h-12 w-12 place-items-center rounded-btn bg-lime/15 text-2xl" aria-hidden="true">
          🎓
        </span>
        <div>
          <p className="text-sm font-semibold text-content-primary">PLE — Personal Learning Environment</p>
          <p className="mt-0.5 text-xs text-content-muted">
            v0.1.0 · local-first · Tauri v2 + Rust + React
          </p>
        </div>
      </div>
    </Section>
  );
}

// ── Software Update ──────────────────────────────────────────────────────────

function SoftwareUpdate() {
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<any>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState("Unknown");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri()) {
      void import("@tauri-apps/api/app").then(m => m.getVersion().then(v => {
        setVersion(v);
        // Track when this version was first seen to display as "Last updated"
        const savedVersion = localStorage.getItem("ple_app_version");
        const savedDate = localStorage.getItem("ple_last_updated");
        
        if (savedVersion !== v) {
          const now = new Date().toLocaleString();
          localStorage.setItem("ple_app_version", v);
          localStorage.setItem("ple_last_updated", now);
          setLastUpdated(now);
        } else if (savedDate) {
          setLastUpdated(savedDate);
        }
      }));
    }
  }, []);

  const checkForUpdates = async () => {
    if (!navigator.onLine) {
      setError("No internet connection.");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateInfo(update);
      } else {
        setUpdateInfo("up-to-date");
      }
    } catch (e) {
      const msg = errMsg(e);
      // If we get a 404 for latest.json, it means the release doesn't have an updater manifest yet.
      // We can gracefully fall back to saying we're up to date.
      if (msg.includes("404") || msg.includes("Could not fetch a valid release JSON")) {
        setUpdateInfo("up-to-date");
      } else {
        setError(msg);
      }
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    if (!updateInfo || typeof updateInfo === "string") return;
    setDownloading(true);
    setError(null);
    let downloaded = 0;
    try {
      await updateInfo.downloadAndInstall((event: any) => {
        switch (event.event) {
          case 'Started':
            setProgress(0);
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (event.data.contentLength) {
              setProgress(Math.round((downloaded / event.data.contentLength) * 100));
            }
            break;
          case 'Finished':
            setProgress(100);
            break;
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setError(errMsg(e));
      setDownloading(false);
    }
  };

  return (
    <Section title="Software Update" description="Check for new versions and install updates seamlessly over-the-air.">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between rounded-btn bg-white/[0.03] px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-content-primary">Current Version</p>
            <p className="text-xs text-content-muted">
              v{version}
              {lastUpdated && <span className="ml-2 text-[0.7rem] opacity-70">· Last updated: {lastUpdated}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void checkForUpdates()}
            disabled={checking || downloading}
            className="rounded-btn border border-white/10 px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary disabled:opacity-50"
          >
            {checking ? "Checking..." : "Check for Updates"}
          </button>
        </div>

        {updateInfo === "up-to-date" && (
          <p className="text-sm text-lime">You are already on the latest version.</p>
        )}

        {updateInfo && typeof updateInfo !== "string" && (
          <div className="rounded-card border border-lime/20 bg-lime/5 p-4 shadow-[inset_0_0_20px_rgba(170,255,0,0.05)]">
            <h3 className="text-sm font-semibold text-lime">Update Available: v{updateInfo.version}</h3>
            {updateInfo.body && (
              <div className="mt-2 whitespace-pre-wrap text-xs text-content-secondary">
                {updateInfo.body}
              </div>
            )}
            
            {downloading ? (
              <div className="mt-4 flex flex-col gap-2">
                <div className="flex justify-between text-xs font-medium text-lime">
                  <span>Downloading & Installing...</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/20">
                  <div className="h-full bg-lime shadow-glow-lime transition-all duration-200" style={{ width: `${progress}%` }} />
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void installUpdate()}
                className="mt-4 rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02]"
              >
                Install Update & Restart
              </button>
            )}
          </div>
        )}

        {error && <p className="text-sm text-orange">{error}</p>}
      </div>
    </Section>
  );
}

// ── Consistency Tracking (Planning Hub) ──────────────────────────────────────

const CONSISTENCY_KEY = "consistency.enabled";

function ConsistencyTracking() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    void ipc.getSetting(CONSISTENCY_KEY).then((v) => {
      setEnabled(v === "true" || v === "1");
      setLoaded(true);
    });
  }, []);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    try {
      await ipc.setSetting(CONSISTENCY_KEY, next ? "true" : "false");
    } catch {
      setEnabled(!next); // revert on failure
    }
  };

  return (
    <Section
      title="Consistency Tracking"
      description="Track a Consistency Score, streak, and heatmap based on deadline performance. Daily snapshots refresh when tasks are completed and during app startup, so enabling the view can reveal previously recorded history."
    >
      <label className="flex cursor-pointer items-center gap-3 rounded-btn bg-white/[0.03] px-3 py-2.5 text-sm transition-colors hover:bg-white/[0.05]">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-4 w-4 accent-lime"
        />
        <span className={enabled ? "text-content-primary" : "text-content-secondary"}>
          {enabled ? "Consistency tracking is on" : "Consistency tracking is off"}
        </span>
        <span className="ml-auto text-[0.7rem] text-content-faint">
          {enabled ? "score + heatmap shown" : "history still recorded"}
        </span>
      </label>
    </Section>
  );
}

// ── Focus Timer (Pomodoro durations) ─────────────────────────────────────────

const PHASE_META: { phase: Phase; label: string; icon: typeof Timer; accent: string; ring: string }[] = [
  { phase: "work", label: "Focus", icon: Timer, accent: "text-lime", ring: "focus-within:border-lime/40" },
  { phase: "short_break", label: "Short Break", icon: Coffee, accent: "text-cyan-400", ring: "focus-within:border-cyan-400/40" },
  { phase: "long_break", label: "Long Break", icon: Moon, accent: "text-orange", ring: "focus-within:border-orange/40" },
];

/** seconds → {h, m, s} for the three number inputs. */
function splitHMS(total: number): { h: number; m: number; s: number } {
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/** A single h/m/s row for one phase; writes back the composed total in seconds. */
function DurationRow({
  meta,
  seconds,
  onChange,
}: {
  meta: (typeof PHASE_META)[number];
  seconds: number;
  onChange: (total: number) => void;
}) {
  const { h, m, s } = splitHMS(seconds);
  const Icon = meta.icon;

  const set = (part: "h" | "m" | "s", raw: string) => {
    const max = part === "h" ? 8 : 59;
    const n = Math.max(0, Math.min(max, Math.floor(Number(raw) || 0)));
    const next = { h, m, s, [part]: n } as { h: number; m: number; s: number };
    if (next.h === 8) {
      next.m = 0;
      next.s = 0;
    }
    onChange(next.h * 3600 + next.m * 60 + next.s);
  };

  const field = (
    label: string,
    value: number,
    max: number,
    part: "h" | "m" | "s",
  ) => (
    <label className={"flex flex-col items-center gap-1 rounded-btn border border-white/10 bg-white/[0.02] px-2.5 py-1.5 transition-colors " + meta.ring}>
      <input
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => set(part, e.target.value)}
        aria-label={`${meta.label} ${label}`}
        className="w-12 bg-transparent text-center font-mono text-lg font-bold tabular-nums text-content-primary outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="text-[0.6rem] uppercase tracking-wide text-content-faint">{label}</span>
    </label>
  );

  return (
    <div className="flex items-center gap-3 rounded-btn bg-white/[0.03] px-3 py-2.5">
      <span className="flex min-w-[8.5rem] items-center gap-2 text-sm font-medium text-content-primary">
        <Icon size={16} strokeWidth={2} className={meta.accent} aria-hidden />
        {meta.label}
      </span>
      <div className="flex items-center gap-2">
        {field("hrs", h, 8, "h")}
        <span className="text-content-faint">:</span>
        {field("min", m, 59, "m")}
        <span className="text-content-faint">:</span>
        {field("sec", s, 59, "s")}
      </div>
    </div>
  );
}

function FocusTimer() {
  const durations = useTimerStore((s) => s.durations);
  const setDurations = useTimerStore((s) => s.setDurations);
  const active = useTimerStore((s) => s.running || s.pausedRemaining != null);

  const resetDefaults = () =>
    setDurations({
      work: TIMER_DEFAULTS.work,
      short_break: TIMER_DEFAULTS.short_break,
      long_break: TIMER_DEFAULTS.long_break,
    });

  return (
    <Section
      title="Focus Timer"
      description="Set the length of each Pomodoro phase in hours, minutes, and seconds. Changes save instantly and sync to the timer in the top bar. A long break arrives automatically after every 4 focus sessions."
    >
      <div className="flex flex-col gap-2">
        <DurationRow meta={PHASE_META[0]} seconds={durations.work} onChange={(v) => setDurations({ work: v })} />
        <DurationRow meta={PHASE_META[1]} seconds={durations.short_break} onChange={(v) => setDurations({ short_break: v })} />
        <DurationRow meta={PHASE_META[2]} seconds={durations.long_break} onChange={(v) => setDurations({ long_break: v })} />
      </div>

      {active && (
        <p className="mt-3 text-xs text-content-faint">
          A session is running — the new lengths take effect on the next phase.
        </p>
      )}

      <button
        type="button"
        onClick={resetDefaults}
        className="mt-4 inline-flex items-center gap-2 rounded-btn border border-white/10 px-3 py-1.5 text-xs text-content-secondary transition-colors hover:bg-white/[0.05]"
      >
        <RotateCcw size={13} strokeWidth={2} aria-hidden />
        Reset to 25 / 5 / 15
      </button>
    </Section>
  );
}

// ── Dashboard Widgets (show/hide + reorder) ──────────────────────────────────

function DashboardWidgets() {
  const [layout, setLayout] = useState<DashboardLayout>(defaultLayout);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadLayout().then((l) => {
      if (alive) {
        setLayout(l);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // Persist on every change (optimistic; the setting write is non-critical).
  const persist = useCallback((next: DashboardLayout) => {
    setLayout(next);
    void saveLayout(next).catch(() => {});
    setNote("Saved — changes apply when you return to the Dashboard.");
  }, []);

  const toggle = (idx: number) => {
    persist(layout.map((w, i) => (i === idx ? { ...w, visible: !w.visible } : w)));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= layout.length) return;
    const next = [...layout];
    [next[idx], next[target]] = [next[target], next[idx]];
    persist(next);
  };

  const reset = () => persist(defaultLayout());

  return (
    <Section
      title="Dashboard Widgets"
      description="Show, hide, and reorder the cards on your Dashboard. Order here is the order they appear (top-to-bottom, left-to-right in the grid)."
    >
      {!isTauri() && (
        <p className="mb-3 text-xs text-content-faint">
          Preview mode — open in the desktop app to save changes.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {layout.map((w, idx) => {
          const meta = widgetMeta(w.id);
          if (!meta) return null;
          return (
            <li
              key={w.id}
              className={
                "flex items-center gap-3 rounded-btn bg-white/[0.03] px-3 py-2.5 transition-opacity " +
                (w.visible ? "" : "opacity-55")
              }
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0 || !loaded}
                  aria-label={`Move ${meta.label} up`}
                  className="grid h-4 w-5 place-items-center text-content-faint transition-colors hover:text-content-primary disabled:opacity-30"
                >
                  <ArrowUp size={13} strokeWidth={2.5} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, 1)}
                  disabled={idx === layout.length - 1 || !loaded}
                  aria-label={`Move ${meta.label} down`}
                  className="grid h-4 w-5 place-items-center text-content-faint transition-colors hover:text-content-primary disabled:opacity-30"
                >
                  <ArrowDown size={13} strokeWidth={2.5} aria-hidden />
                </button>
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-content-primary">{meta.label}</p>
                <p className="truncate text-xs text-content-muted">{meta.description}</p>
              </div>

              <button
                type="button"
                onClick={() => toggle(idx)}
                disabled={!loaded}
                aria-pressed={w.visible}
                aria-label={w.visible ? `Hide ${meta.label}` : `Show ${meta.label}`}
                className={
                  "flex items-center gap-1.5 rounded-btn border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 " +
                  (w.visible
                    ? "border-lime/40 bg-lime/10 text-lime"
                    : "border-white/10 text-content-secondary hover:bg-white/[0.05]")
                }
              >
                {w.visible ? <Eye size={13} strokeWidth={2} /> : <EyeOff size={13} strokeWidth={2} />}
                {w.visible ? "Shown" : "Hidden"}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={reset}
          disabled={!loaded}
          className="rounded-btn border border-white/10 px-3 py-1.5 text-xs text-content-secondary transition-colors hover:bg-white/[0.05] disabled:opacity-50"
        >
          Reset to default
        </button>
        {note && <p className="text-xs text-lime">{note}</p>}
      </div>
    </Section>
  );
}

// ── Page (two-pane: left-nav tab rail + content panel) ───────────────────────

type CategoryId = "library" | "appearance" | "focus" | "playback" | "data" | "update" | "about";

interface Category {
  id: CategoryId;
  label: string;
  icon: typeof Folder;
  description: string;
  render: () => React.ReactNode;
}

const CATEGORIES: Category[] = [
  {
    id: "library",
    label: "Library & Content",
    icon: Folder,
    description: "Manage the folders PLE scans for learning material.",
    render: () => <ManageFolders />,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    description: "Theme and the layout of your Dashboard.",
    render: () => (
      <>
        <Theme />
        <DashboardWidgets />
      </>
    ),
  },
  {
    id: "focus",
    label: "Focus & Planning",
    icon: Timer,
    description: "Pomodoro durations and consistency tracking.",
    render: () => (
      <>
        <FocusTimer />
        <ConsistencyTracking />
      </>
    ),
  },
  {
    id: "playback",
    label: "Playback",
    icon: Play,
    description: "The default in-app video engine.",
    render: () => <DefaultPlayer />,
  },
  {
    id: "data",
    label: "Data",
    icon: Database,
    description: "Export, back up, or import your local data.",
    render: () => <DataManagement />,
  },
  {
    id: "update",
    label: "Software Update",
    icon: DownloadCloud,
    description: "Over-the-air app updates.",
    render: () => <SoftwareUpdate />,
  },
  {
    id: "about",
    label: "About & Shortcuts",
    icon: Info,
    description: "Keyboard shortcuts and app info.",
    render: () => (
      <>
        <Shortcuts />
        <About />
      </>
    ),
  },
];

export default function Settings() {
  const location = useLocation();

  // Deep-link support: /settings#library selects that category on load.
  const initial = useMemo<CategoryId>(() => {
    const hash = location.hash.replace("#", "") as CategoryId;
    return CATEGORIES.some((c) => c.id === hash) ? hash : "library";
  }, [location.hash]);

  const [active, setActive] = useState<CategoryId>(initial);

  useEffect(() => {
    setActive(initial);
  }, [initial]);

  const activeCategory = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0];

  const select = (id: CategoryId) => {
    setActive(id);
    // Reflect the selection in the URL hash (shallow — no reload).
    window.history.replaceState(null, "", `#${id}`);
  };

  // Roving arrow-key navigation across the tab rail.
  const onRailKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const idx = CATEGORIES.findIndex((c) => c.id === active);
    let next = idx;
    if (e.key === "ArrowDown") next = (idx + 1) % CATEGORIES.length;
    else if (e.key === "ArrowUp") next = idx <= 0 ? CATEGORIES.length - 1 : idx - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = CATEGORIES.length - 1;
    select(CATEGORIES[next].id);
  };

  return (
    <div className="min-h-full px-6 pb-10">
      <div className="animate-fade-up mx-auto max-w-6xl">
        <Breadcrumb items={[{ label: "Settings" }]} />

        <header className="mb-6 mt-3">
          <h1 className="text-2xl font-bold text-content-primary">Settings</h1>
          <p className="mt-1 text-sm text-content-muted">
            Folders, appearance, focus, playback, and data — organized by category.
          </p>
        </header>

        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          {/* Left nav rail (tablist) */}
          <nav
            aria-label="Settings categories"
            role="tablist"
            aria-orientation="vertical"
            onKeyDown={onRailKeyDown}
            className="flex shrink-0 gap-2 overflow-x-auto md:sticky md:top-20 md:w-60 md:flex-col md:overflow-visible"
          >
            {CATEGORIES.map((c) => {
              const Icon = c.icon;
              const selected = c.id === active;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${c.id}`}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${c.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(c.id)}
                  className={
                    "group flex shrink-0 items-center gap-3 rounded-2xl px-3.5 py-2.5 text-left text-sm font-medium transition-all duration-200 " +
                    (selected
                      ? "bg-white/[0.05] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                      : "text-content-secondary hover:bg-white/[0.04] hover:text-content-primary")
                  }
                >
                  <Icon
                    size={18}
                    strokeWidth={2}
                    className={selected ? "text-lime [filter:drop-shadow(0_0_6px_rgba(170,255,0,0.55))]" : "text-content-muted"}
                    aria-hidden
                  />
                  <span className="truncate">{c.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Content panel */}
          <div
            role="tabpanel"
            id={`settings-panel-${activeCategory.id}`}
            aria-labelledby={`settings-tab-${activeCategory.id}`}
            className="min-w-0 flex-1"
          >
            <p className="mb-4 text-sm text-content-muted">{activeCategory.description}</p>
            <div className="flex flex-col gap-gutter">{activeCategory.render()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
