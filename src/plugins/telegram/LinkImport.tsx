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
import Modal from "../../components/ui/Modal";
import { tg } from "./api";
import type { TgMediaItem } from "./api";
import type { NodeCard } from "../../lib/types";
import { cn } from "../../lib/utils";
import { motion } from "framer-motion";

type Mode = "link" | "browse";

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

function formatDuration(secs: number | null): string {
  if (secs == null || secs <= 0) return "";
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

const TYPE_GLYPH: Record<string, typeof Play> = {
  video: Play,
  audio: Music,
  pdf: FileText,
  image: ImageIcon,
  note: FileType2,
};

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
  const [mediaFilter, setMediaFilter] = useState<"all" | "videos" | "documents">("all");

  const filteredItems = useMemo(() => {
    if (!items) return null;
    return items.filter((item) => {
      if (mediaFilter === "all") return true;
      if (mediaFilter === "videos") return item.file_type === "video";
      return item.file_type !== "video";
    });
  }, [items, mediaFilter]);

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
    setSelectedItems(new Set());
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
      await tg.importLink(`https://t.me/c/${item.chat_id}/${item.message_id}`, nodeId);
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

  const importSelected = async () => {
    if (nodeId == null) {
      setError("Choose a destination folder first.");
      return;
    }
    if (selectedItems.size === 0) return;
    
    setError(null);
    const toImport = Array.from(selectedItems);
    
    // Process sequentially to avoid rate-limits or backend overload
    for (const msgId of toImport) {
      const item = items?.find((i) => i.message_id === msgId);
      if (!item || item.already_imported) continue;

      setImporting((prev) => new Set(prev).add(msgId));
      try {
        await tg.importLink(`https://t.me/c/${item.chat_id}/${msgId}`, nodeId);
        setItems((prev) =>
          prev?.map((i) => (i.message_id === msgId ? { ...i, already_imported: true } : i)) ?? null
        );
        setSelectedItems((prev) => {
          const next = new Set(prev);
          next.delete(msgId);
          return next;
        });
        onImported?.();
      } catch (e) {
        setError(messageOf(e));
        // Continue loop to allow other items to succeed
      } finally {
        setImporting((prev) => {
          const next = new Set(prev);
          next.delete(msgId);
          return next;
        });
      }
    }
  };

  const actionDisabled = busy || !url.trim() || (mode === "link" && nodeId == null);

  const browseStats = useMemo(() => {
    if (!filteredItems || filteredItems.length === 0) return null;
    const totalBytes = filteredItems.reduce((sum, i) => sum + (i.size_bytes ?? 0), 0);
    const already = filteredItems.filter((i) => i.already_imported).length;
    return { totalBytes, already };
  }, [filteredItems]);

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
              "relative inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2AABEE]/40",
              mode === id
                ? "bg-[#2AABEE] text-white shadow-[0_2px_10px_rgba(42,171,238,0.3)]"
                : "text-content-secondary hover:bg-white/[0.05] hover:text-content-primary"
            )}
          >
            <Icon size={16} strokeWidth={mode === id ? 2.5 : 2} aria-hidden />
            <span className="leading-none">{label}</span>
            <span
              className={cn(
                "hidden leading-none sm:inline",
                mode === id ? "text-white/70" : "text-content-faint"
              )}
            >
              · {hint}
            </span>
          </button>
        ))}
      </div>

      {/* Responsive layout wrapper */}
      <div className={cn("flex flex-col gap-6 transition-all duration-500", mode === "browse" && "xl:flex-row xl:items-start")}>
        <div className={cn("w-full transition-all duration-500", mode === "browse" && "xl:w-[40%] xl:sticky xl:top-6")}>
          {/* Input card */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 shadow-card hover:border-[#2AABEE]/20 transition-colors duration-500">
        <label className="block relative group">
          <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-[#2AABEE]/0 via-[#2AABEE]/10 to-[#2AABEE]/0 opacity-0 group-focus-within:opacity-100 blur-md transition-opacity duration-500" />
          <span className="mb-2 flex items-center gap-2 text-sm font-medium text-content-secondary">
            <LinkIcon size={14} strokeWidth={2} className="text-[#2AABEE]" aria-hidden />
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
                "relative z-10 w-full rounded-xl border border-white/10 bg-[#09090b] px-4 py-3.5 pr-24 font-mono text-sm text-content-primary outline-none transition-all placeholder:text-content-faint focus:border-[#2AABEE]/50 focus:shadow-[0_0_15px_rgba(42,171,238,0.15)]",
                busy && "opacity-60"
              )}
            />
            <span className="pointer-events-none absolute z-20 right-3 top-1/2 -translate-y-1/2 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-content-faint">
              {mode === "link" ? "t.me/c/…" : "t.me or @"}
            </span>
          </div>
        </label>

        {/* Destination Section */}
        <div className="mt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
           <div className="flex-1">
              <span className="mb-1 flex items-center gap-1.5 text-sm font-medium text-content-secondary">
                 <FolderPlus size={14} strokeWidth={2} className="text-lime" aria-hidden />
                 Destination
              </span>
              <button
                 onClick={() => setIsNodePickerOpen(true)}
                 className="flex w-full sm:max-w-xs items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-sm text-content-primary transition-all hover:bg-white/[0.04] hover:border-lime/30"
              >
                 {destination ? (
                    <span className="flex items-center gap-2 truncate">
                       <Check size={14} strokeWidth={3} className="text-lime shrink-0" />
                       <span className="truncate">{destination.name}</span>
                    </span>
                 ) : (
                    <span className="text-content-faint">Choose a folder...</span>
                 )}
              </button>
           </div>
           
           {/* Action */}
           <div className="shrink-0 pt-6 sm:pt-0">
             <button
                type="button"
                onClick={() => void (mode === "link" ? importOne() : browse())}
                disabled={actionDisabled}
                className={cn(
                   "inline-flex h-[42px] min-w-[140px] items-center justify-center gap-2 rounded-xl bg-lime px-5 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] active:scale-[0.98]",
                   actionDisabled && "cursor-not-allowed opacity-50 hover:scale-100 shadow-none"
                )}
             >
                {busy ? (
                   <Loader2 size={16} strokeWidth={2.5} className="animate-spin" aria-hidden />
                ) : (
                   <Send size={15} strokeWidth={2.5} aria-hidden />
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
        </div>

        {/* Feedback */}
        {error && (
          <p role="alert" className="mt-5 flex items-start gap-2 rounded-xl border border-orange/25 bg-orange/10 px-4 py-3 text-sm text-orange">
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

        {/* Browse results */}
        {mode === "browse" && items != null && (
          <div className="flex-1 min-w-0 w-full">
            <motion.div
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               className="glass rounded-2xl border border-white/15 bg-[#050506]/50 shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.1)] p-4 max-h-[calc(100vh-380px)] xl:max-h-[calc(100vh-420px)] min-h-[250px] overflow-y-auto relative scroll-thin"
            >
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
               <span className="grid h-12 w-12 place-items-center rounded-xl bg-white/[0.03]">
                  <FolderTree size={20} className="text-content-faint" />
               </span>
               <p className="mt-4 text-sm text-content-muted">
                 No media found in that channel's recent messages.
               </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-3 px-1 pb-4 pt-1 text-xs text-content-faint">
                <span className="flex items-center gap-1.5">
                  <Sparkles size={14} strokeWidth={2} className="text-[#2AABEE]" aria-hidden />
                  <span className="font-medium text-content-secondary">
                    {filteredItems!.length} file{filteredItems!.length === 1 ? "" : "s"}
                  </span>
                  {browseStats && browseStats.totalBytes > 0 && (
                    <span>· {formatSize(browseStats.totalBytes)}</span>
                  )}
                </span>

                <div className="hidden sm:block mx-1 h-4 w-px bg-white/10" />

                {/* Filter Pills */}
                <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.02] p-1 shadow-inner">
                  {(["all", "videos", "documents"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setMediaFilter(f)}
                      className={cn(
                        "relative rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2AABEE]",
                        mediaFilter === f ? "text-white" : "text-content-secondary hover:text-content-primary hover:bg-white/5"
                      )}
                    >
                      {mediaFilter === f && (
                        <motion.div
                          layoutId="tg-media-filter"
                          className="absolute inset-0 bg-gradient-to-br from-blue-600/90 to-blue-400/90 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.3),_0_0_15px_rgba(59,130,246,0.5)] border border-blue-400/30"
                          transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                        />
                      )}
                      <span className="relative z-10 capitalize">{f}</span>
                    </button>
                  ))}
                </div>

                {/* Select All Toggle */}
                {filteredItems!.length > 0 && (
                  <button
                    onClick={() => {
                      const unimported = filteredItems!.filter(i => !i.already_imported);
                      const allSelected = unimported.length > 0 && unimported.every(i => selectedItems.has(i.message_id));
                      
                      setSelectedItems((prev) => {
                        const next = new Set(prev);
                        if (allSelected) {
                          unimported.forEach(i => next.delete(i.message_id));
                        } else {
                          unimported.forEach(i => next.add(i.message_id));
                        }
                        return next;
                      });
                    }}
                    className="flex items-center gap-1.5 rounded bg-white/[0.04] px-2 py-1 transition-colors hover:bg-white/[0.08]"
                  >
                    <div className={cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border",
                      (() => {
                        const unimported = filteredItems!.filter(i => !i.already_imported);
                        const allSelected = unimported.length > 0 && unimported.every(i => selectedItems.has(i.message_id));
                        return allSelected ? "border-[#2AABEE] bg-[#2AABEE] text-white" : "border-white/20 bg-transparent text-transparent";
                      })()
                    )}>
                      <Check size={10} strokeWidth={3} />
                    </div>
                    Select {(() => {
                      const unimported = filteredItems!.filter(i => !i.already_imported);
                      const allSelected = unimported.length > 0 && unimported.every(i => selectedItems.has(i.message_id));
                      return allSelected ? "None" : "All";
                    })()}
                  </button>
                )}

                <div className="flex-1" />

                {/* Import Selected Button */}
                {selectedItems.size > 0 ? (
                  <button
                    onClick={() => void importSelected()}
                    disabled={nodeId == null || busy}
                    className="flex shrink-0 items-center gap-1.5 rounded-full bg-lime px-3 py-1 font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
                  >
                    <Download size={12} strokeWidth={2.5} />
                    Import {selectedItems.size} Selected
                  </button>
                ) : (
                  nodeId == null ? (
                    <span className="text-orange rounded-full bg-orange/10 px-2 py-0.5">Choose destination</span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-lime/10 px-2.5 py-0.5 text-lime border border-lime/20">
                      <Check size={12} strokeWidth={3} aria-hidden />
                      Dest: {destination?.name}
                    </span>
                  )
                )}
              </div>

              <ul className="flex flex-col gap-2">
                {filteredItems!.length === 0 ? (
                  <li className="py-8 text-center text-sm text-content-faint">
                    No files match the selected filter.
                  </li>
                ) : (
                  filteredItems!.map((item) => {
                    const isImporting = importing.has(item.message_id);
                    const isSelected = selectedItems.has(item.message_id);
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
                        onClick={() => {
                          if (item.already_imported || isImporting) return;
                          setSelectedItems((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.message_id)) next.delete(item.message_id);
                            else next.add(item.message_id);
                            return next;
                          });
                        }}
                        className={cn(
                          "group flex cursor-pointer items-center gap-4 rounded-xl border px-4 py-3 transition-all hover:-translate-y-[1px]",
                          isSelected 
                            ? "border-[#2AABEE]/40 bg-[#2AABEE]/10 shadow-[0_0_15px_rgba(42,171,238,0.05)]" 
                            : "border-white/[0.04] bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]"
                        )}
                      >
                        {/* Checkbox */}
                        <div className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                          item.already_imported
                            ? "border-lime/30 bg-lime/10 text-lime"
                            : isSelected
                              ? "border-[#2AABEE] bg-[#2AABEE] text-white"
                              : "border-white/20 bg-black/20 text-transparent group-hover:border-white/40"
                        )}>
                          <Check size={11} strokeWidth={3} />
                        </div>

                        <span
                          aria-hidden
                          className={cn(
                            "grid h-10 w-10 shrink-0 place-items-center rounded-xl border",
                            item.file_type === "video"
                              ? "border-lime/20 bg-lime/10 text-lime shadow-[0_0_10px_rgba(163,230,53,0.1)]"
                              : item.file_type === "pdf"
                                ? "border-orange/20 bg-orange/10 text-orange"
                                : "border-white/10 bg-white/[0.05] text-content-secondary"
                          )}
                        >
                          <Glyph size={18} strokeWidth={2} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-content-primary group-hover:text-white transition-colors">{item.file_name}</p>
                          <p className="mt-1 flex items-center gap-2 text-xs text-content-muted">
                            <span className="rounded bg-white/5 px-1.5 py-0.5 uppercase tracking-wide text-content-faint">
                              {item.file_type}
                            </span>
                            {meta && <span>{meta}</span>}
                          </p>
                        </div>
                        {item.already_imported ? (
                          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-lime/20 bg-lime/10 px-3 py-1.5 text-xs font-semibold text-lime shadow-[0_0_8px_rgba(163,230,53,0.1)]">
                            <Check size={14} strokeWidth={2.5} aria-hidden />
                            In library
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void importItem(item);
                            }}
                            disabled={isImporting || nodeId == null}
                            className={cn(
                              "inline-flex h-[34px] min-w-[80px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-xs font-semibold text-content-secondary transition-all hover:border-[#2AABEE]/40 hover:bg-[#2AABEE]/10 hover:text-[#2AABEE] active:scale-[0.97]",
                              (isImporting || nodeId == null) && "cursor-not-allowed opacity-40 hover:scale-100 hover:border-white/10 hover:bg-white/[0.03] hover:text-content-secondary"
                            )}
                          >
                            {isImporting ? (
                              <Loader2 size={13} strokeWidth={2.5} className="animate-spin" aria-hidden />
                            ) : (
                              <Download size={13} strokeWidth={2} aria-hidden />
                            )}
                            {isImporting ? "..." : "Import"}
                          </button>
                        )}
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          )}
            </motion.div>
          </div>
        )}
      </div>
    </div>
  );
}
