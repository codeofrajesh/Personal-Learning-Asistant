/**
 * LinkImport — bring Telegram media into the library (premium redesign).
 *
 * Two modes over one destination picker, because they are the same task at different scales:
 * a single lesson ("One link") and a channel's recent media ("Browse channel"). Splitting them
 * into separate screens would duplicate the destination step, which is the part that actually
 * needs care — a lesson imported into the wrong folder is worse than one not imported.
 *
 * Destination reuses `NodePicker` (the wizard's drill-down tree) rather than a new tree
 * widget: it already handles roots, depth and empty states, and matching the folder-choosing
 * interaction students already know matters more here than saving a click.
 *
 * The flow is identical to before — same `tg.importLink` / `tg.channelMedia` calls, same
 * state model. This file is presentation: a glassy input card, a cleaner mode switch, richer
 * browse rows (type glyph, duration, size, already-imported state) and an `onImported`
 * callback so the page can refresh its history section the moment something lands.
 */

import { useMemo, useState } from "react";
import {
  Link as LinkIcon,
  FolderTree,
  Check,
  Loader2,
  Download,
  Sparkles,
  FolderPlus,
  Send,
  FileType2,
  Play,
  Music,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
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

/** Type glyph for a browse row — mirrors the library's TYPE_GLYPH map. */
const TYPE_GLYPH: Record<string, typeof Play> = {
  video: Play,
  audio: Music,
  pdf: FileText,
  image: ImageIcon,
  note: FileType2,
};

interface LinkImportProps {
  /** Called after any import succeeds so the parent can refresh its history section. */
  onImported?: () => void;
}

export default function LinkImport({ onImported }: LinkImportProps) {
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
      onImported?.();
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
      onImported?.();
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

  const actionDisabled = busy || !url.trim() || (mode === "link" && nodeId == null);

  // Aggregate stats for the browse results header.
  const browseStats = useMemo(() => {
    if (!items || items.length === 0) return null;
    const totalBytes = items.reduce((sum, i) => sum + (i.size_bytes ?? 0), 0);
    const already = items.filter((i) => i.already_imported).length;
    return { totalBytes, already };
  }, [items]);

  return (
    <div className="space-y-5">
      {/* Mode switch — premium segmented control */}
      <div
        role="tablist"
        aria-label="Import mode"
        className="inline-flex rounded-btn border border-white/10 bg-white/[0.03] p-1"
      >
        {(
          [
            { id: "link" as Mode, label: "One link", hint: "a single lesson", icon: LinkIcon },
            { id: "browse" as Mode, label: "Browse channel", hint: "recent media", icon: FolderTree },
          ]
        ).map(({ id, label, hint, icon: Icon }) => (
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
              "relative inline-flex items-center gap-2 rounded-btn px-3.5 py-2 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40",
              mode === id
                ? "bg-lime text-ink-900 shadow-glow-lime"
                : "text-content-secondary hover:bg-white/[0.05] hover:text-content-primary"
            )}
          >
            <Icon size={14} strokeWidth={2} aria-hidden />
            <span className="leading-none">{label}</span>
            <span
              className={cn(
                "hidden leading-none sm:inline",
                mode === id ? "text-ink-900/60" : "text-content-faint"
              )}
            >
              · {hint}
            </span>
          </button>
        ))}
      </div>

      {/* Input card */}
      <div className="rounded-card border border-white/[0.06] bg-white/[0.02] p-4">
        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-content-secondary">
            <LinkIcon size={13} strokeWidth={2} className="text-lime" aria-hidden />
            {mode === "link" ? "Message link" : "Channel, invite link, or @username"}
          </span>
          <div className="relative">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !actionDisabled) void (mode === "link" ? importOne() : browse());
              }}
              placeholder={
                mode === "link" ? "https://t.me/c/1234567890/42" : "https://t.me/+AbCdEf… or @mychannel"
              }
              spellCheck={false}
              className={cn(
                "w-full rounded-btn border border-white/10 bg-white/[0.03] px-3.5 py-2.5 pr-24 font-mono text-xs text-content-primary outline-none transition-colors placeholder:text-content-faint focus:border-lime/40",
                busy && "opacity-60"
              )}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-content-faint">
              {mode === "link" ? "t.me/c/…" : "t.me or @"}
            </span>
          </div>
          <span className="mt-1.5 block text-xs text-content-faint">
            {mode === "link" ? (
              <>
                In Telegram: right-click the message → <span className="text-content-secondary">Copy Message Link</span>.
              </>
            ) : (
              "An invite link works for private channels with no username — including your own. Nothing is joined; the channel is only read."
            )}
          </span>
        </label>

        {/* Destination */}
        <div className="mt-4">
          <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-content-secondary">
            <FolderPlus size={13} strokeWidth={2} className="text-lime" aria-hidden />
            Import into
            {destination && (
              <span className="ml-auto inline-flex max-w-[16rem] items-center gap-1 truncate rounded-full border border-lime/25 bg-lime/10 px-2 py-0.5 text-xs font-medium text-lime">
                <Check size={11} strokeWidth={3} aria-hidden className="shrink-0" />
                <span className="truncate">{destination.name}</span>
              </span>
            )}
          </span>
          <NodePicker selectedId={nodeId} onSelect={setDestination} />
        </div>

        {/* Feedback */}
        {error && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-btn border border-orange/25 bg-orange/10 px-3 py-2.5 text-sm text-orange">
            {error}
          </p>
        )}
        {done && (
          <p aria-live="polite" className="mt-4 flex items-start gap-2 rounded-btn border border-lime/20 bg-lime/[0.08] px-3 py-2.5 text-sm text-lime">
            <Check size={15} strokeWidth={2.5} className="mt-0.5 shrink-0" aria-hidden />
            {done}
          </p>
        )}

        {/* Action */}
        <button
          type="button"
          onClick={() => void (mode === "link" ? importOne() : browse())}
          disabled={actionDisabled}
          className={cn(
            "mt-4 inline-flex w-full items-center justify-center gap-2 rounded-btn bg-lime px-4 py-2.5 text-sm font-semibold text-ink-900 shadow-glow-lime transition-all hover:scale-[1.01] active:scale-[0.99]",
            actionDisabled && "cursor-not-allowed opacity-50 hover:scale-100"
          )}
        >
          {busy ? (
            <Loader2 size={15} strokeWidth={2.5} className="animate-spin" aria-hidden />
          ) : (
            <Send size={14} strokeWidth={2.5} aria-hidden />
          )}
          {busy
            ? mode === "link"
              ? "Importing…"
              : "Loading…"
            : mode === "link"
              ? "Import lesson"
              : "Show media"}
        </button>
      </div>

      {/* Browse results */}
      {mode === "browse" && items != null && (
        <div className="rounded-card border border-white/[0.06] bg-white/[0.02] p-3">
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-content-muted">
              No media found in that channel's recent messages.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-2 pt-1 text-xs text-content-faint">
                <span className="flex items-center gap-1.5">
                  <Sparkles size={12} strokeWidth={2} className="text-lime" aria-hidden />
                  <span className="font-medium text-content-secondary">
                    {items.length} file{items.length === 1 ? "" : "s"}
                  </span>
                  {browseStats && browseStats.totalBytes > 0 && (
                    <span>· {formatSize(browseStats.totalBytes)}</span>
                  )}
                </span>
                {nodeId == null ? (
                  <span className="text-orange">Choose a destination folder to import</span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Check size={11} strokeWidth={3} className="text-lime" aria-hidden />
                    Importing into {destination?.name}
                  </span>
                )}
              </div>

              <ul className="flex flex-col gap-1">
                {items.map((item) => {
                  const isImporting = importing.has(item.message_id);
                  const Glyph = TYPE_GLYPH[item.file_type] ?? FileType2;
                  const meta = [
                    formatDuration(item.duration_secs),
                    formatSize(item.size_bytes),
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li
                      key={item.message_id}
                      className="group flex items-center gap-3 rounded-btn border border-transparent bg-white/[0.02] px-3 py-2 transition-colors hover:border-white/[0.08] hover:bg-white/[0.04]"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "grid h-9 w-9 shrink-0 place-items-center rounded-btn border",
                          item.file_type === "video"
                            ? "border-lime/20 bg-lime/10 text-lime"
                            : item.file_type === "pdf"
                              ? "border-orange/20 bg-orange/10 text-orange"
                              : "border-white/10 bg-white/[0.05] text-content-secondary"
                        )}
                      >
                        <Glyph size={16} strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-content-primary">{item.file_name}</p>
                        <p className="mt-0.5 text-xs text-content-muted">
                          <span className="uppercase tracking-wide text-content-faint">
                            {item.file_type}
                          </span>
                          {meta && (
                            <>
                              {" · "}
                              {meta}
                            </>
                          )}
                        </p>
                      </div>
                      {item.already_imported ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-lime/20 bg-lime/10 px-2 py-1 text-xs font-medium text-lime">
                          <Check size={12} strokeWidth={2.5} aria-hidden />
                          In library
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void importItem(item)}
                          disabled={isImporting || nodeId == null}
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1.5 rounded-btn border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:border-lime/30 hover:bg-lime/10 hover:text-lime",
                            (isImporting || nodeId == null) && "cursor-not-allowed opacity-40 hover:border-white/10 hover:bg-white/[0.03] hover:text-content-secondary"
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
