/**
 * Formatting & small utility helpers shared across the UI.
 * Pure functions only — no React, no side effects.
 */

/** Join class names, dropping falsy values. Tiny local `clsx`. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Human-readable file size (1024-based). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Seconds → `H:MM:SS` / `M:SS`. Returns "—" for null/NaN (metadata unavailable). */
export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || Number.isNaN(secs) || secs < 0) return "—";
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
