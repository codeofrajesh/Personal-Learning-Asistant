/**
 * Import lessons from Telegram: one link, a range, or by browsing a channel.
 *
 * All three modes end at the same place — a list of what was found, with the student ticking
 * what they want and `tg_import_batch` committing it. Range used to be the exception: it swept
 * and imported in one step, so a mistyped bound became rows to delete rather than a list to
 * ignore. Now it scans, shows, and waits.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link as LinkIcon,
  FolderTree,
  Check,
  Loader2,
  FolderPlus,
  Send,
  Layers,
  Hash,
  MessagesSquare,
  ScanLine,
} from "lucide-react";
import NodePicker from "../../components/wizard/NodePicker";
import Modal from "../../components/ui/Modal";
import RangeSweep from "./RangeSweep";
import MediaSelectList from "./MediaSelectList";
import type { MediaFilter } from "./MediaSelectList";
import { onImportProgress, tg } from "./api";
import type { TgMediaItem, TgRangeProgress } from "./api";
import type { NodeCard } from "../../lib/types";
import { cn } from "../../lib/utils";
import { AnimatePresence, motion } from "framer-motion";

type Mode = "link" | "range" | "browse";

/** How a range says where to stop. */
type RangeBound = "end" | "count";

interface LinkImportProps {
  onImported?: () => void;
}

export default function LinkImport({ onImported }: LinkImportProps) {
  const [mode, setMode] = useState<Mode>("link");
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState<NodeCard | null>(null);
  const [isNodePickerOpen, setIsNodePickerOpen] = useState(false);
  const nodeId = destination?.id ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [items, setItems] = useState<TgMediaItem[] | null>(null);
  const [importing, setImporting] = useState<Set<number>>(new Set());
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");

  // ── Range mode ──
  const [endUrl, setEndUrl] = useState("");
  const [rangeBound, setRangeBound] = useState<RangeBound>("count");
  const [count, setCount] = useState("20");
  const [progress, setProgress] = useState<TgRangeProgress | null>(null);
  /** What the last scan covered, kept for the summary above the list. */
  const [scanSummary, setScanSummary] = useState<string | null>(null);

  // Subscribe once and route ticks into state. The listener has to outlive any single scan
  // (it is set up before the first one and torn down on unmount), so it can't live inside the
  // scan handler — a per-call subscription would race the first event.
  const progressRef = useRef<TgRangeProgress | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onImportProgress((tick) => {
      progressRef.current = tick;
      setProgress(tick);
    }).then((fn) => {
      // Unsubscribe immediately if the component unmounted before the listener resolved.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const messageOf = (e: unknown) =>
    typeof e === "string" ? e : e instanceof Error ? e.message : "Import failed.";

  /** Clear whatever the previous run left on screen. */
  const resetResults = () => {
    setError(null);
    setDone(null);
    setItems(null);
    setSelectedItems(new Set());
    setScanSummary(null);
    setProgress(null);
    progressRef.current = null;
  };

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
          : `Updated “${result.file_name}” — it was already in your library.`,
      );
      setUrl("");
      onImported?.();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Sweep the range and show what's in it. Writes nothing — the student picks from the result
   * and `importSelected` does the importing.
   */
  const scanRange = async () => {
    const parsedCount = Number.parseInt(count, 10);
    if (rangeBound === "count" && (!Number.isFinite(parsedCount) || parsedCount < 1)) {
      setError("Enter how many lessons to look for.");
      return;
    }
    if (rangeBound === "end" && !endUrl.trim()) {
      setError("Paste the link of the last lesson in the range.");
      return;
    }

    setBusy(true);
    resetResults();

    try {
      const result = await tg.scanRange(
        url,
        rangeBound === "end" ? { endUrl: endUrl.trim() } : { count: parsedCount },
      );
      // Oldest first, so Lesson 1, 2, 3 read top-to-bottom.
      const found = [...result.items].sort((a, b) => a.message_id - b.message_id);
      setItems(found);
      // Pre-tick everything not already in the library: the student asked for this range, so
      // "all of it" is the expected answer and unticking a few is less work than ticking fifty.
      setSelectedItems(new Set(found.filter((i) => !i.already_imported).map((i) => i.message_id)));

      const parts = [`Found ${found.length} file${found.length === 1 ? "" : "s"}`];
      parts.push(`scanned ${result.scanned} message${result.scanned === 1 ? "" : "s"}`);
      if (result.truncated) parts.push("stopped at the safety limit");
      setScanSummary(parts.join(" · "));
    } catch (e) {
      setError(messageOf(e));
      // A failed sweep leaves a half-filled rail, which would read as partial success.
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    setBusy(true);
    resetResults();
    try {
      const fetched = await tg.channelMedia(url);
      // Sort ascending (oldest first) so that Lesson 1, 2, 3 appear in order top-to-bottom.
      setItems([...fetched].sort((a, b) => a.message_id - b.message_id));
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
      await tg.importLink(`https://t.me/c/${item.chat_id}/${item.message_id}`, nodeId);
      setItems(
        (prev) =>
          prev?.map((i) =>
            i.message_id === item.message_id ? { ...i, already_imported: true } : i,
          ) ?? null,
      );
      setSelectedItems((prev) => {
        const next = new Set(prev);
        next.delete(item.message_id);
        return next;
      });
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

  const importSelected = async () => {
    if (nodeId == null) {
      setError("Choose a destination folder first.");
      return;
    }
    if (selectedItems.size === 0) return;

    setError(null);
    setDone(null);
    const toImport = Array.from(selectedItems);

    try {
      setBusy(true);
      setImporting((prev) => {
        const next = new Set(prev);
        toImport.forEach((id) => next.add(id));
        return next;
      });

      // One transaction in the backend: every ticked lesson lands, or none does.
      const results = await tg.importBatch(url, toImport, nodeId);

      const imported = new Set(toImport);
      setItems(
        (prev) =>
          prev?.map((i) => (imported.has(i.message_id) ? { ...i, already_imported: true } : i)) ??
          null,
      );
      setSelectedItems(new Set());
      const where = destination ? ` into ${destination.name}` : "";
      setDone(`Imported ${results.length} lesson${results.length === 1 ? "" : "s"}${where}.`);
      onImported?.();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setImporting((prev) => {
        const next = new Set(prev);
        toImport.forEach((id) => next.delete(id));
        return next;
      });
      setBusy(false);
    }
  };

  // Every mode needs a start link; range also needs its bound filled in, and only the
  // single-link path writes straight away, so only it needs a destination up front.
  const rangeIncomplete =
    mode === "range" && (rangeBound === "end" ? !endUrl.trim() : !count.trim());
  const actionDisabled = busy || !url.trim() || rangeIncomplete || (mode === "link" && nodeId == null);

  /** Run whichever action the current mode maps to. */
  const runAction = () => {
    if (mode === "link") return importOne();
    if (mode === "range") return scanRange();
    return browse();
  };

  /**
   * Does the start link look like it names a forum topic?
   *
   * Display-only: the backend parser is the authority on what a link means, and this exists
   * purely to warn before a sweep that the range will be topic-scoped. Deliberately loose —
   * a false negative just omits a hint, and nothing branches on it.
   */
  const startLooksLikeTopic = useMemo(() => {
    const raw = url.trim();
    if (!raw) return false;
    if (/[?&]thread=\d+/.test(raw)) return true;
    // `/c/<id>/<topic>/<msg>` or `/<username>/<topic>/<msg>` — three numeric-ish path
    // segments after the host, with the last two both numbers.
    const path = raw.split("#")[0].split("?")[0];
    const segments = path.replace(/^https?:\/\//, "").split("/").filter(Boolean);
    // Drop the host, leaving the path segments.
    const parts = segments.slice(1);
    if (parts[0] === "c") return parts.length === 4 && /^\d+$/.test(parts[2]);
    return parts.length === 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]);
  }, [url]);

  // Both list-producing modes share the split layout: controls on the left, results beside them.
  const hasList = (mode === "browse" || mode === "range") && items != null;
  // The rail is live feedback, so it gives way once there's a real list to look at.
  const showSweep = mode === "range" && (busy || (progress != null && items == null));

  return (
    <div className="space-y-6">
      {/* Mode switch — premium segmented control */}
      <div
        role="tablist"
        aria-label="Import mode"
        className="inline-flex rounded-xl border border-white/10 bg-white/[0.02] p-1 shadow-inner"
      >
        {(
          [
            { id: "link" as Mode, label: "One link", hint: "a single lesson", icon: LinkIcon },
            { id: "range" as Mode, label: "Range", hint: "many at once", icon: Layers },
            {
              id: "browse" as Mode,
              label: "Browse channel",
              hint: "recent media",
              icon: FolderTree,
            },
          ]
        ).map(({ id, label, hint, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => {
              setMode(id);
              resetResults();
            }}
            className={cn(
              "relative inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2AABEE]/40",
              mode === id
                ? "bg-[#2AABEE] text-white shadow-[0_2px_10px_rgba(42,171,238,0.3)]"
                : "text-content-secondary hover:bg-white/[0.05] hover:text-content-primary",
            )}
          >
            <Icon size={16} strokeWidth={mode === id ? 2.5 : 2} aria-hidden />
            <span className="leading-none">{label}</span>
            <span
              className={cn(
                "hidden leading-none sm:inline",
                mode === id ? "text-white/70" : "text-content-faint",
              )}
            >
              · {hint}
            </span>
          </button>
        ))}
      </div>

      {/* Responsive layout wrapper */}
      <div
        className={cn(
          "flex flex-col gap-6 transition-all duration-500",
          hasList && "xl:flex-row xl:items-start",
        )}
      >
        <div
          className={cn(
            "w-full transition-all duration-500",
            hasList && "xl:sticky xl:top-6 xl:w-[40%]",
          )}
        >
          {/* Input card */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 shadow-card transition-colors duration-500 hover:border-[#2AABEE]/20">
            <label className="group relative block">
              <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-[#2AABEE]/0 via-[#2AABEE]/10 to-[#2AABEE]/0 opacity-0 blur-md transition-opacity duration-500 group-focus-within:opacity-100" />
              <span className="mb-2 flex items-center gap-2 text-sm font-medium text-content-secondary">
                <LinkIcon size={14} strokeWidth={2} className="text-[#2AABEE]" aria-hidden />
                {mode === "link"
                  ? "Message link"
                  : mode === "range"
                    ? "First lesson in the range"
                    : "Channel, invite link, or @username"}
              </span>
              <div className="relative">
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !actionDisabled) void runAction();
                  }}
                  placeholder={
                    mode === "browse"
                      ? "https://t.me/+AbCdEf… or @mychannel"
                      : "https://t.me/c/1234567890/42"
                  }
                  spellCheck={false}
                  className={cn(
                    "relative z-10 w-full rounded-xl border border-white/10 bg-[#09090b] px-4 py-3.5 pr-24 font-mono text-sm text-content-primary outline-none transition-all placeholder:text-content-faint focus:border-[#2AABEE]/50 focus:shadow-[0_0_15px_rgba(42,171,238,0.15)]",
                    busy && "opacity-60",
                  )}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 z-20 -translate-y-1/2 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-content-faint">
                  {mode === "browse" ? "t.me or @" : "t.me/c/…"}
                </span>
              </div>
            </label>

            {/* Range controls. Shown only in range mode so the single-link path stays a one-field
                form — the common case shouldn't pay for the rarer one. */}
            {mode === "range" && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="mt-5 rounded-2xl border border-white/[0.06] bg-black/20 p-4"
              >
                {/* Where the range stops. Two genuinely different questions, so they get a switch
                    rather than one field that means different things. */}
                <div
                  role="radiogroup"
                  aria-label="Where the range ends"
                  className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-1"
                >
                  {(
                    [
                      { id: "count" as RangeBound, label: "Next N lessons", icon: Hash },
                      { id: "end" as RangeBound, label: "Up to a link", icon: MessagesSquare },
                    ]
                  ).map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={rangeBound === id}
                      onClick={() => {
                        setRangeBound(id);
                        setError(null);
                      }}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2AABEE]/40",
                        rangeBound === id
                          ? "bg-white/[0.08] text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                          : "text-content-secondary hover:text-content-primary",
                      )}
                    >
                      <Icon size={13} strokeWidth={2} aria-hidden />
                      {label}
                    </button>
                  ))}
                </div>

                <div className="mt-4">
                  {rangeBound === "count" ? (
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-content-secondary">
                        How many lessons
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={count}
                        onChange={(e) => setCount(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !actionDisabled) void runAction();
                        }}
                        className="w-32 rounded-xl border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-content-primary outline-none transition-all focus:border-[#2AABEE]/50"
                      />
                      <p className="mt-2 text-xs text-content-faint">
                        Counts files, not messages — text posts in between don't use up the total.
                      </p>
                    </label>
                  ) : (
                    <label className="block">
                      <span className="mb-2 block text-sm font-medium text-content-secondary">
                        Last lesson in the range
                      </span>
                      <input
                        value={endUrl}
                        onChange={(e) => setEndUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !actionDisabled) void runAction();
                        }}
                        placeholder="https://t.me/c/1234567890/122"
                        spellCheck={false}
                        className="w-full rounded-xl border border-white/10 bg-[#09090b] px-4 py-2.5 font-mono text-sm text-content-primary outline-none transition-all placeholder:text-content-faint focus:border-[#2AABEE]/50"
                      />
                      <p className="mt-2 text-xs text-content-faint">
                        Both links must come from the same channel.
                      </p>
                    </label>
                  )}
                </div>

                {/* Forum links carry their topic, and the sweep stays inside it. Saying so up front
                    prevents the "why did it only find some of them" question. */}
                {startLooksLikeTopic && (
                  <p className="mt-4 flex items-start gap-2 rounded-xl border border-[#2AABEE]/20 bg-[#2AABEE]/[0.07] px-3 py-2 text-xs text-[#2AABEE]">
                    <MessagesSquare
                      size={13}
                      strokeWidth={2}
                      className="mt-[2px] shrink-0"
                      aria-hidden
                    />
                    That's a forum topic link — only lessons in that topic will be found.
                  </p>
                )}
              </motion.div>
            )}

            {/* Destination Section */}
            <div className="mt-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex-1">
                <span className="mb-1 flex items-center gap-1.5 text-sm font-medium text-content-secondary">
                  <FolderPlus size={14} strokeWidth={2} className="text-lime" aria-hidden />
                  Destination
                </span>
                <button
                  type="button"
                  onClick={() => setIsNodePickerOpen(true)}
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-sm text-content-primary transition-all hover:border-lime/30 hover:bg-white/[0.04] sm:max-w-xs"
                >
                  {destination ? (
                    <span className="flex items-center gap-2 truncate">
                      <Check size={14} strokeWidth={3} className="shrink-0 text-lime" aria-hidden />
                      <span className="truncate">{destination.name}</span>
                    </span>
                  ) : (
                    <span className="text-content-faint">Choose a folder…</span>
                  )}
                </button>
              </div>

              {/* Action */}
              <div className="shrink-0 pt-6 sm:pt-0">
                <button
                  type="button"
                  onClick={() => void runAction()}
                  disabled={actionDisabled}
                  className={cn(
                    "inline-flex h-[42px] min-w-[140px] items-center justify-center gap-2 rounded-xl bg-lime px-5 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] active:scale-[0.98]",
                    actionDisabled && "cursor-not-allowed opacity-50 shadow-none hover:scale-100",
                  )}
                >
                  {busy ? (
                    <Loader2 size={16} strokeWidth={2.5} className="animate-spin" aria-hidden />
                  ) : mode === "range" ? (
                    <ScanLine size={15} strokeWidth={2.5} aria-hidden />
                  ) : (
                    <Send size={15} strokeWidth={2.5} aria-hidden />
                  )}
                  {busy
                    ? mode === "link"
                      ? "Importing…"
                      : mode === "range"
                        ? "Scanning…"
                        : "Loading…"
                    : mode === "link"
                      ? "Import lesson"
                      : mode === "range"
                        ? "Scan range"
                        : "Show media"}
                </button>
              </div>
            </div>

            {/* Live sweep, while the range is being walked. It gives way to the list of results,
                which is a far better answer to "did that work" than a full rail. */}
            <AnimatePresence>
              {showSweep && (
                <motion.div
                  key="sweep"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="mt-5">
                    <RangeSweep progress={progress} active={busy} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Feedback */}
            {error && (
              <p
                role="alert"
                className="mt-5 flex items-start gap-2 rounded-xl border border-orange/25 bg-orange/10 px-4 py-3 text-sm text-orange"
              >
                {error}
              </p>
            )}
            {done && (
              <motion.p
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-5 flex items-start gap-2 rounded-xl border border-lime/20 bg-lime/[0.08] px-4 py-3 text-sm text-lime shadow-[0_0_10px_rgba(163,230,53,0.1)]"
              >
                <Check size={16} strokeWidth={2.5} className="mt-[1px] shrink-0" aria-hidden />
                {done}
              </motion.p>
            )}
          </div>

          {/* Destination Picker Modal */}
          <Modal
            open={isNodePickerOpen}
            onClose={() => setIsNodePickerOpen(false)}
            title="Choose destination"
            subtitle="Select a folder to import the media into."
            widthClass="max-w-xl"
          >
            <div className="py-2">
              <NodePicker
                selectedId={nodeId}
                onSelect={(node) => {
                  setDestination(node);
                  setIsNodePickerOpen(false);
                }}
              />
            </div>
          </Modal>
        </div>

        {/* Results — the same selection list for a scanned range and a browsed channel */}
        {hasList && (
          <div className="w-full min-w-0 flex-1">
            <MediaSelectList
              items={items!}
              filter={mediaFilter}
              onFilterChange={setMediaFilter}
              selected={selectedItems}
              onSelectedChange={setSelectedItems}
              importing={importing}
              onImportOne={(item) => void importItem(item)}
              onImportSelected={() => void importSelected()}
              destinationName={destination?.name ?? null}
              busy={busy}
              summary={mode === "range" ? (scanSummary ?? undefined) : undefined}
              emptyMessage={
                mode === "range"
                  ? "No files in that range. Check the links point at lessons with a video, PDF, or audio file."
                  : "No media found in that channel's recent messages."
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
