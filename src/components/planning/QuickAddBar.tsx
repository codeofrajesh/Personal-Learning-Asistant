/**
 * QuickAddBar — a sleek single-line task capture with slash commands, replacing the
 * cramped inline pill row. Type a title, and layer intent inline:
 *
 *   /high /medium /low        → priority
 *   /today /tomorrow /weekend → deadline (end of day)
 *   /1h /45m /2h              → time estimate
 *   /link                     → open the material search to attach a lesson
 *
 * Tokens are parsed out of the title on submit (Enter), so "Read chapter 4 /high /today"
 * creates a high-priority task due today titled "Read chapter 4". A live hint row shows
 * the parsed chips as you type. "More options" opens the full glass TaskModal for
 * anything fiddly. Fast for power users, discoverable for everyone.
 */

import { useMemo, useRef, useState } from "react";
import { Plus, SlidersHorizontal, Search, X } from "lucide-react";
import { PRIORITY_META, toIsoDateTime } from "./planningUtils";
import { ipc } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type { SearchResult } from "../../lib/types";
import type { NewTaskInput } from "./usePlanningTasks";

const DEFAULT_HOUR = 18;

interface Parsed {
  title: string;
  priority: number;
  due_at: string | null;
  estimated_mins: number | null;
  wantsLink: boolean;
}

/** Parse slash-command tokens out of raw quick-add text. */
function parse(raw: string): Parsed {
  let priority = 0;
  let due_at: string | null = null;
  let estimated_mins: number | null = null;
  let wantsLink = false;

  const dayAt = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(DEFAULT_HOUR, 0, 0, 0);
    return toIsoDateTime(d);
  };
  const weekendAt = () => {
    const d = new Date();
    const untilSat = (6 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + untilSat);
    d.setHours(DEFAULT_HOUR, 0, 0, 0);
    return toIsoDateTime(d);
  };

  const kept: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    const t = tok.toLowerCase();
    if (t === "/high") priority = 3;
    else if (t === "/medium" || t === "/med") priority = 2;
    else if (t === "/low") priority = 1;
    else if (t === "/today") due_at = dayAt(0);
    else if (t === "/tomorrow" || t === "/tmr") due_at = dayAt(1);
    else if (t === "/weekend") due_at = weekendAt();
    else if (t === "/link") wantsLink = true;
    else if (/^\/\d+(m|h)$/.test(t)) {
      const m = t.slice(1);
      estimated_mins = m.endsWith("h") ? parseInt(m) * 60 : parseInt(m);
    } else {
      kept.push(tok);
    }
  }
  return { title: kept.join(" ").trim(), priority, due_at, estimated_mins, wantsLink };
}

interface Props {
  onAdd: (input: NewTaskInput) => void;
  onOpenModal: () => void;
}

export default function QuickAddBar({ onAdd, onOpenModal }: Props) {
  const [text, setText] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [linked, setLinked] = useState<SearchResult | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  const parsed = useMemo(() => parse(text), [text]);

  const runSearch = (q: string) => {
    setQuery(q);
    window.clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      void ipc.searchMaterials(q, "all").then((r) => setResults(r.slice(0, 5))).catch(() => setResults([]));
    }, 300);
  };

  const submit = () => {
    if (!parsed.title) {
      // If they only typed "/link", open the picker instead of creating an empty task.
      if (parsed.wantsLink) setLinkOpen(true);
      return;
    }
    onAdd({
      title: parsed.title,
      priority: parsed.priority,
      due_at: parsed.due_at,
      estimated_mins: parsed.estimated_mins,
      material_id: linked?.id ?? null,
      material_name: linked?.file_name ?? null,
      material_type: linked?.file_type ?? null,
    });
    setText("");
    setLinked(null);
    setLinkOpen(false);
    setQuery("");
    setResults([]);
  };

  // Live chips reflecting parsed tokens.
  const chips: { label: string; className: string }[] = [];
  if (parsed.priority > 0) {
    const p = PRIORITY_META[parsed.priority];
    chips.push({ label: p.label, className: cn("border-white/10", p.text) });
  }
  if (parsed.due_at) {
    const d = new Date(parsed.due_at.replace(" ", "T"));
    chips.push({
      label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      className: "border-orange/25 text-orange",
    });
  }
  if (parsed.estimated_mins) {
    chips.push({
      label: parsed.estimated_mins < 60 ? `${parsed.estimated_mins}m` : `${parsed.estimated_mins / 60}h`,
      className: "border-white/10 text-content-secondary",
    });
  }
  if (linked) {
    chips.push({ label: linked.file_name, className: "border-cyan-400/25 text-cyan-300" });
  }

  const openLinkFromToken = parsed.wantsLink && !linked && !linkOpen;
  if (openLinkFromToken) {
    // Auto-open the picker the moment "/link" is typed.
    queueMicrotask(() => setLinkOpen(true));
  }

  return (
    <div className="rounded-[16px] border border-white/[0.06] bg-black/30 focus-within:border-lime/30">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Plus size={16} strokeWidth={2} className="shrink-0 text-white/40" aria-hidden />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add a task…  try /high  /today  /1h  /link"
          aria-label="Quick add task"
          className="min-w-0 flex-1 bg-transparent text-sm text-content-primary placeholder:text-white/30 focus:outline-none"
        />
        <button
          type="button"
          onClick={onOpenModal}
          aria-label="More options"
          title="More options"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-btn text-white/40 transition-colors hover:bg-white/[0.06] hover:text-content-primary"
        >
          <SlidersHorizontal size={15} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {/* Parsed chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
          {chips.map((c, i) => (
            <span key={i} className={cn("rounded-full border px-2 py-0.5 text-[0.66rem] font-medium", c.className)}>
              {c.label}
            </span>
          ))}
        </div>
      )}

      {/* Inline link picker (opened by the /link token) */}
      {linkOpen && !linked && (
        <div className="border-t border-white/[0.06] p-2">
          <div className="flex items-center gap-2 rounded-btn bg-white/[0.04] px-2.5 py-2">
            <Search size={14} strokeWidth={2} className="text-white/40" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => runSearch(e.target.value)}
              placeholder="Search a lesson to link…"
              aria-label="Search materials to link"
              className="min-w-0 flex-1 bg-transparent text-sm text-content-primary placeholder:text-white/30 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                setLinkOpen(false);
                setText((t) => t.replace(/\s*\/link/gi, ""));
              }}
              aria-label="Cancel link"
              className="grid h-6 w-6 place-items-center rounded-full text-white/30 hover:bg-white/[0.06] hover:text-content-primary"
            >
              <X size={13} strokeWidth={2} aria-hidden />
            </button>
          </div>
          {results.length > 0 && (
            <ul className="mt-2 flex flex-col">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setLinked(r);
                      setLinkOpen(false);
                      setText((t) => t.replace(/\s*\/link/gi, ""));
                      setQuery("");
                      setResults([]);
                    }}
                    className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-xs text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
                  >
                    <span className="min-w-0 flex-1 truncate">{r.file_name}</span>
                    <span className="shrink-0 text-[0.6rem] uppercase text-white/30">{r.file_type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
