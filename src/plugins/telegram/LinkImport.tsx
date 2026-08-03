/**
 * LinkImport — bring Telegram media into the library.
 *
 * Two modes over one destination picker, because they are the same task at different scales:
 * a single lesson ("Link") and a channel's recent media ("Browse"). Splitting them into
 * separate screens would duplicate the destination step, which is the part that actually
 * needs care — a lesson imported into the wrong folder is worse than one not imported.
 *
 * Destination reuses `NodePicker` (the wizard's drill-down tree) rather than a new tree
 * widget: it already handles roots, depth and empty states, and matching the folder-choosing
 * interaction students already know matters more here than saving a click.
 */

import { useState } from "react";
import { Link as LinkIcon, FolderTree, Check, Loader2, Download } from "lucide-react";
import NodePicker from "../../components/wizard/NodePicker";
import { tg } from "./api";
import type { TgMediaItem } from "./api";
import type { NodeCard } from "../../lib/types";
import { cn } from "../../lib/utils";

type Mode = "link" | "browse";

/** Human file size. Telegram reports exact bytes and raw numbers are unreadable at a glance. */
function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `1h 05m` / `12m 30s` — matches how the rest of the app renders durations. */
function formatDuration(secs: number | null): string {
  if (secs == null || secs <= 0) return "";
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export default function LinkImport() {
  const [mode, setMode] = useState<Mode>("link");
  const [url, setUrl] = useState("");
  // The whole node, not just its id: `NodePicker` hands it over anyway, and having the name
  // lets the confirmation say *where* the lesson landed — which is the one thing the student
  // needs to verify after an import.
  const [destination, setDestination] = useState<NodeCard | null>(null);
  const nodeId = destination?.id ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Browse mode state.
  const [items, setItems] = useState<TgMediaItem[] | null>(null);
  /** message_ids currently importing — so one row's spinner doesn't freeze the whole list. */
  const [importing, setImporting] = useState<Set<number>>(new Set());

  const messageOf = (e: unknown) =>
    typeof e === "string" ? e : e instanceof Error ? e.message : "Import failed.";

  const importOne = async () => {
    if (nodeId == null) {
      setError("Choose a destination folder first.");
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await tg.importLink(url, nodeId);
      const where = destination ? ` into ${destination.name}` : "";
      setDone(
        result.created
          ? `Imported “${result.file_name}”${where}.`
          : `Updated “${result.file_name}” — it was already in your library.`
      );
      setUrl("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    setItems(null);
    try {
      setItems(await tg.channelMedia(url));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const importItem = async (item: TgMediaItem) => {
    if (nodeId == null) {
      setError("Choose a destination folder first.");
      return;
    }
    setError(null);
    setImporting((prev) => new Set(prev).add(item.message_id));
    try {
      // Rebuild the canonical link for this message rather than reusing the pasted URL —
      // that URL may point at a different message in the same channel.
      await tg.importLink(`https://t.me/c/${item.chat_id}/${item.message_id}`, nodeId);
      // Patch the one row locally instead of refetching the channel: a refetch costs a
      // network round trip (and flood-wait budget) to learn something already known.
      setItems(
        (prev) =>
          prev?.map((i) =>
            i.message_id === item.message_id ? { ...i, already_imported: true } : i
          ) ?? null
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setImporting((prev) => {
        const next = new Set(prev);
        next.delete(item.message_id);
        return next;
      });
    }
  };

  const inputClass =
    "w-full rounded-btn border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-content-primary outline-none transition-colors focus:border-lime/40";
  const primaryBtn =
    "inline-flex items-center gap-2 rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] active:scale-[0.98]";

  return (
    <div className="space-y-5">
      {/* Mode toggle */}
      <div
        role="tablist"
        aria-label="Import mode"
        className="inline-flex rounded-btn border border-white/10 bg-white/[0.03] p-0.5"
      >
        {(
          [
            { id: "link" as Mode, label: "One link", icon: LinkIcon },
            { id: "browse" as Mode, label: "Browse channel", icon: FolderTree },
          ]
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => {
              setMode(id);
              setError(null);
              setDone(null);
              setItems(null);
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-xs font-medium transition-colors",
              mode === id
                ? "bg-lime/15 text-lime"
                : "text-content-secondary hover:text-content-primary"
            )}
          >
            <Icon size={13} strokeWidth={2} aria-hidden />
            {label}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-content-secondary">
          {mode === "link" ? "Message link" : "Channel link or @username"}
        </span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={
            mode === "link" ? "https://t.me/c/1234567890/42" : "@mychannel or https://t.me/c/1234567890"
          }
          spellCheck={false}
          className={cn(inputClass, "font-mono text-xs")}
        />
        <span className="mt-1 block text-xs text-content-faint">
          {mode === "link"
            ? "In Telegram: right-click the message → Copy Message Link."
            : "Any message link from the channel works too."}
        </span>
      </label>

      {/* Destination */}
      <div>
        <span className="mb-1.5 block text-sm font-medium text-content-secondary">
          Import into
        </span>
        <NodePicker selectedId={nodeId} onSelect={setDestination} />
      </div>

      {error && (
        <p role="alert" className="text-sm text-orange">
          {error}
        </p>
      )}
      {done && (
        <p aria-live="polite" className="flex items-center gap-1.5 text-sm text-lime">
          <Check size={14} strokeWidth={2.5} aria-hidden />
          {done}
        </p>
      )}

      <button
        type="button"
        onClick={() => void (mode === "link" ? importOne() : browse())}
        disabled={busy || !url.trim() || (mode === "link" && nodeId == null)}
        className={cn(
          primaryBtn,
          (busy || !url.trim() || (mode === "link" && nodeId == null)) &&
            "cursor-not-allowed opacity-60"
        )}
      >
        {busy && <Loader2 size={14} strokeWidth={2.5} className="animate-spin" aria-hidden />}
        {busy
          ? mode === "link"
            ? "Importing…"
            : "Loading…"
          : mode === "link"
            ? "Import lesson"
            : "Show media"}
      </button>

      {/* Browse results */}
      {mode === "browse" && items != null && (
        <div className="space-y-2">
          {items.length === 0 ? (
            <p className="text-sm text-content-muted">
              No media found in that channel's recent messages.
            </p>
          ) : (
            <>
              <p className="text-xs text-content-faint">
                {items.length} file{items.length === 1 ? "" : "s"} found
                {nodeId == null && " — choose a destination folder to import"}
              </p>
              <ul className="flex flex-col gap-1.5">
                {items.map((item) => {
                  const isImporting = importing.has(item.message_id);
                  const meta = [
                    item.file_type,
                    formatDuration(item.duration_secs),
                    formatSize(item.size_bytes),
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li
                      key={item.message_id}
                      className="flex items-center gap-3 rounded-btn bg-white/[0.03] px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-content-primary">{item.file_name}</p>
                        <p className="mt-0.5 text-xs text-content-muted">{meta}</p>
                      </div>
                      {item.already_imported ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-lime">
                          <Check size={13} strokeWidth={2.5} aria-hidden />
                          In library
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void importItem(item)}
                          disabled={isImporting || nodeId == null}
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1.5 rounded-btn border border-white/10 px-2.5 py-1 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary",
                            (isImporting || nodeId == null) && "cursor-not-allowed opacity-50"
                          )}
                        >
                          {isImporting ? (
                            <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden />
                          ) : (
                            <Download size={12} strokeWidth={2} aria-hidden />
                          )}
                          {isImporting ? "Importing…" : "Import"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
