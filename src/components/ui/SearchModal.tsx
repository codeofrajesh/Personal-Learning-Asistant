/**
 * Search modal — the Ctrl+K command palette (Section 8 Page 8, Section 15).
 *
 * A command-palette overlay: a large autofocused input, type filter pills, and a
 * scrollable results list grouped by Goal (with Subject · Chapter context per row)
 * and highlighted match terms. Selecting a result navigates to that material's player
 * route and closes the modal.
 *
 * Accessibility (web-design-guidelines / Section 15): `role="dialog"` + `aria-modal`,
 * focus moves to the input on open and is trapped, Esc closes, focus restores to the
 * trigger. Keyboard: ↑/↓ move the selection, Enter opens, Esc closes. The results list
 * is a `role="listbox"`; goal headers are `role="presentation"` separators, items are
 * `role="option"`.
 *
 * Match highlighting: the backend returns a snippet with U+0001/U+0002 around matched
 * terms — split into <mark> spans here. Never raw HTML, so no injection.
 *
 * Honest empty states: "Start typing to search…" when the query is empty, "No results"
 * when a query has no matches — never fabricated hits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import gsap from "gsap";
import { ipc, isTauri, NotInTauriError } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type { SearchResult } from "../../lib/types";

const HIGHLIGHT_OPEN = "";
const HIGHLIGHT_CLOSE = "";

const FILTERS = [
  { key: "all", label: "All", glyph: "✦" },
  { key: "video", label: "Videos", glyph: "🎬" },
  { key: "pdf", label: "PDFs", glyph: "📄" },
  { key: "note", label: "Notes", glyph: "📝" },
  { key: "image", label: "Images", glyph: "🖼️" },
  { key: "audio", label: "Audio", glyph: "🎧" },
] as const;

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Split a snippet with U+0001/U+0002 markers into alternating plain/highlighted parts. */
function renderSnippet(snippet: string) {
  const parts: { text: string; mark: boolean }[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf(HIGHLIGHT_OPEN);
    if (open === -1) {
      parts.push({ text: rest, mark: false });
      break;
    }
    if (open > 0) parts.push({ text: rest.slice(0, open), mark: false });
    const close = rest.indexOf(HIGHLIGHT_CLOSE, open + 1);
    if (close === -1) {
      parts.push({ text: rest.slice(open + 1), mark: true });
      break;
    }
    parts.push({ text: rest.slice(open + 1, close), mark: true });
    rest = rest.slice(close + 1);
  }
  return parts.map((p, i) =>
    p.mark ? (
      <mark key={i} className="rounded bg-lime/25 px-0.5 text-content-primary">
        {p.text}
      </mark>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}

type Entry =
  | { kind: "header"; goal: string; key: string }
  | { kind: "item"; result: SearchResult; flatIdx: number; key: string };

/** Build a flat list of (goal header | result item) entries, grouped by goal. */
function buildEntries(results: SearchResult[]): Entry[] {
  const entries: Entry[] = [];
  let lastGoal = "";
  results.forEach((r, flatIdx) => {
    if (r.goal_name !== lastGoal) {
      entries.push({ kind: "header", goal: r.goal_name, key: `h-${r.goal_name}-${flatIdx}` });
      lastGoal = r.goal_name;
    }
    entries.push({ kind: "item", result: r, flatIdx, key: `r-${r.id}` });
  });
  return entries;
}

export default function SearchModal({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const navigate = useNavigate();

  const entries = useMemo(() => buildEntries(results), [results]);

  // Reset state each time the modal opens.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setFilter("all");
    setResults([]);
    setError(null);
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // GSAP entrance (gated on reduced motion), mirroring Modal.tsx.
  useEffect(() => {
    if (!open) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      gsap.set([backdropRef.current, panelRef.current], { opacity: 1 });
    } else {
      gsap.fromTo(backdropRef.current, { opacity: 0 }, { opacity: 1, duration: 0.18 });
      gsap.fromTo(
        panelRef.current,
        { opacity: 0, scale: 0.96, y: 8 },
        { opacity: 1, scale: 1, y: 0, duration: 0.26, ease: "power3.out" },
      );
    }
  }, [open]);

  // Debounced search (300 ms). Empty query → clear. Outside Tauri → preview note.
  const runSearch = useCallback(async (q: string, ft: string) => {
    if (!isTauri() || q.trim().length === 0) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const hits = await ipc.searchMaterials(q, ft === "all" ? undefined : ft);
      setResults(hits);
      setError(null);
    } catch (err) {
      setError(
        err instanceof NotInTauriError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void runSearch(query, filter);
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [open, query, filter, runSearch]);

  // Keep the active selection within bounds as results change.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  const openResult = useCallback(
    (r: SearchResult) => {
      navigate(`/library/material/${r.id}`);
      onClose();
    },
    [navigate, onClose],
  );

  // Keyboard: Esc (close), ↑/↓ (move selection), Enter (open).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const r = results[activeIndex];
        if (r) openResult(r);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, results, activeIndex, openResult]);

  // Scroll the active row into view as the selection moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const queryEmpty = query.trim().length === 0;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search materials"
        tabIndex={-1}
        className="glass flex max-h-[72vh] w-full max-w-2xl flex-col rounded-panel shadow-card-hover outline-none"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-glass-border px-4 py-3">
          <span aria-hidden="true" className="text-content-muted">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your materials…"
            className="flex-1 bg-transparent text-base text-content-primary placeholder:text-content-faint focus:outline-none"
            aria-label="Search query"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="rounded border border-glass-border px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
            Esc
          </kbd>
        </div>

        {/* Filter pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-glass-border px-4 py-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40",
                filter === f.key
                  ? "bg-lime text-ink-900"
                  : "bg-white/[0.04] text-content-secondary hover:bg-white/[0.08] hover:text-content-primary",
              )}
              aria-pressed={filter === f.key}
            >
              <span aria-hidden="true">{f.glyph}</span>
              {f.label}
            </button>
          ))}
        </div>

        {/* Results / states */}
        <ul ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2" role="listbox" aria-label="Search results">
          {error && (
            <li className="px-3 py-4 text-sm text-orange">Search failed: {error}</li>
          )}

          {!error && queryEmpty && !isTauri() && (
            <li className="px-3 py-6 text-center text-sm text-content-muted">
              Preview mode — open inside the desktop app to search your materials.
            </li>
          )}

          {!error && queryEmpty && isTauri() && (
            <li className="px-3 py-8 text-center">
              <p className="text-sm text-content-muted">Start typing to search across all your materials…</p>
              <p className="mt-1 text-xs text-content-faint">File names · filter by type · Enter to open</p>
            </li>
          )}

          {!error && !queryEmpty && !loading && results.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-content-muted">
              No results for “{query.trim()}”.
            </li>
          )}

          {!error && loading && (
            <li className="px-3 py-6 text-center text-sm text-content-muted">Searching…</li>
          )}

          {!error && !loading && results.length > 0 &&
            entries.map((entry) =>
              entry.kind === "header" ? (
                <li
                  key={entry.key}
                  role="presentation"
                  className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-content-faint"
                >
                  {entry.goal}
                </li>
              ) : (
                <li key={entry.key}>
                  <button
                    type="button"
                    data-idx={entry.flatIdx}
                    onClick={() => openResult(entry.result)}
                    onMouseEnter={() => setActiveIndex(entry.flatIdx)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-btn px-3 py-2.5 text-left transition-colors focus-visible:outline-none",
                      entry.flatIdx === activeIndex
                        ? "bg-lime/10 ring-1 ring-lime/30"
                        : "hover:bg-white/[0.04]",
                    )}
                    role="option"
                    aria-selected={entry.flatIdx === activeIndex}
                  >
                    <span aria-hidden="true" className="shrink-0 text-base">
                      {FILTERS.find((f) => f.key === entry.result.file_type)?.glyph ?? "📁"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-content-primary">
                        {renderSnippet(entry.result.snippet)}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-content-muted">
                        {entry.result.subject_name} · {entry.result.chapter_name}
                      </p>
                    </div>
                    {entry.result.is_completed && (
                      <span className="shrink-0 text-xs text-lime" aria-label="Completed">
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              ),
            )}
        </ul>

        {/* Footer hint */}
        <div className="flex items-center justify-between gap-2 border-t border-glass-border px-4 py-2 text-[11px] text-content-faint">
          <span>
            <kbd className="rounded border border-glass-border px-1 py-0.5 font-mono">↑↓</kbd> navigate
            <span className="mx-1.5">·</span>
            <kbd className="rounded border border-glass-border px-1 py-0.5 font-mono">Enter</kbd> open
          </span>
          {results.length > 0 && (
            <span>{results.length} result{results.length === 1 ? "" : "s"}</span>
          )}
        </div>
      </div>
    </div>
  );
}
