/**
 * ComboSelect — a custom combo-box (replaces the native <select>) for the wizard.
 *
 * Two interaction modes (Step 1 of the Courses re-architecture):
 *   - "pick": a trigger button that opens a dropdown of existing options, plus a
 *     "Create new…" entry that flips the control into free-text mode.
 *   - "create": a plain text input (the typed name is the value) with a
 *     "← choose existing" toggle that returns to pick mode.
 *
 * The control is name-based (string) to match the wizard's get-or-create contract:
 * the backend `upsert_goal` / `upsert_subject` resolve by name, so we never need to
 * thread IDs back to the parent. IDs are used only for option keys + matching.
 *
 * Accessibility (ui-ux-pro-max priority-1, design-taste-frontend form rules):
 *   - Trigger is `role="combobox"` with `aria-expanded`, `aria-haspopup="listbox"`,
 *     `aria-controls`, and `aria-activedescendant` tracking the active option.
 *   - Listbox `role="listbox"`, options `role="option"` with `aria-selected`.
 *   - Keyboard: ArrowDown/Up move, Home/End jump, Enter/Space select, Esc closes,
 *     ArrowDown/Enter on a closed combo opens it.
 *   - Click-outside closes; focus stays on the trigger (aria-activedescendant moves).
 *   - Focus ring `ring-lime/25`; labels/values/options/helper text meet WCAG-AA
 *     contrast on the dark surface (content-secondary ≈ 7.5:1, content-primary ≈ 17:1).
 *   - Dropdown reveal is the app's `animate-fade-in` (opacity-only, motion-mild);
 *     the chevron rotation is the directional cue. No GSAP for a simple menu reveal
 *     (design-taste: save GSAP for orchestrated page entrances, not micro-menus).
 *
 * NOTE: the dropdown is absolutely positioned within the field container. The wizard
 * modal is tall (max-h-85vh) and the form is short, so it fits without clipping. If a
 * dropdown ever needs to escape a scroll container, upgrade to a `createPortal`-based
 * floating dropdown (compute rect from the trigger, close on scroll/resize).
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, Plus, Check, ArrowLeft } from "lucide-react";
import { cn } from "../../lib/utils";

export interface ComboOption {
  id: number;
  name: string;
}

interface ComboSelectProps {
  /** Stable id base for label association + aria. */
  id: string;
  label: string;
  /** Current value (a name string). Controlled by the parent. */
  value: string;
  onChange: (name: string) => void;
  /** Existing options to pick from. */
  options: ComboOption[];
  /** True while options are loading (shows a "Loading…" row). */
  loading?: boolean;
  disabled?: boolean;
  /** Placeholder shown in the trigger when no value is set. */
  placeholder?: string;
  /** Helper text under the control (WCAG-AA via content-secondary). */
  helperText?: string;
  /** Placeholder for the create-mode text input. */
  createNewPlaceholder?: string;
  /** Hint shown when the options list is empty (pick mode). */
  emptyHint?: string;
  /** When true, render a plain controlled text input (browser-preview fallback). */
  forceTextFallback?: boolean;
}

const triggerBase =
  "flex w-full items-center justify-between gap-2 rounded-btn border bg-ink-850 px-3 py-2 text-sm outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const triggerRest =
  "border-glass-border text-content-primary hover:border-white/15 focus:border-lime/60 focus:ring-2 focus:ring-lime/25";
const inputClass =
  "w-full rounded-btn border border-glass-border bg-ink-850 px-3 py-2 text-sm text-content-primary placeholder:text-content-muted outline-none transition-colors focus:border-lime/60 focus:ring-2 focus:ring-lime/25 disabled:opacity-50";
const labelClass =
  "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-content-secondary";
const helperClass = "mt-1 text-xs text-content-secondary";
const itemBase =
  "flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-sm outline-none transition-colors";

export default function ComboSelect({
  id,
  label,
  value,
  onChange,
  options,
  loading = false,
  disabled = false,
  placeholder = "Select…",
  helperText,
  createNewPlaceholder = "Type a new name…",
  emptyHint = "Nothing here yet.",
  forceTextFallback = false,
}: ComboSelectProps) {
  const [mode, setMode] = useState<"pick" | "create">("pick");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // Combined items for keyboard nav: existing options + a "create new" sentinel last.
  const items = useMemo(
    () => [
      ...options.map((o) => ({ kind: "option" as const, id: o.id, name: o.name })),
      { kind: "create" as const, id: -1, name: "" },
    ],
    [options],
  );

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.name === value),
    [options, value],
  );

  const optionId = (idx: number) => `${listId}-opt-${idx}`;
  const triggerElId = `${id}-trigger`;
  const createElId = `${id}-create`;
  const fieldId = mode === "pick" ? triggerElId : createElId;

  // ── open / close / select ──
  const openDropdown = useCallback(() => {
    setOpen(true);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [selectedIndex]);

  const closeDropdown = useCallback(() => setOpen(false), []);

  const pickOption = useCallback(
    (opt: ComboOption) => {
      onChange(opt.name);
      setOpen(false);
      setMode("pick");
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const enterCreate = useCallback(() => {
    setOpen(false);
    setMode("create");
    // Keep the current value so a pre-filled name is editable, not erased.
    requestAnimationFrame(() => createInputRef.current?.focus());
  }, []);

  const backToPick = useCallback(() => {
    setMode("pick");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const selectActive = useCallback(() => {
    const item = items[activeIndex];
    if (!item) return;
    if (item.kind === "option") pickOption({ id: item.id, name: item.name });
    else enterCreate();
  }, [items, activeIndex, pickOption, enterCreate]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) closeDropdown();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, closeDropdown]);

  // Keep the active option scrolled into view as the selection moves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  // Combobox keyboard handling on the trigger (WAI-ARIA authoring pattern).
  const onTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      switch (e.key) {
        case "Enter":
        case " ":
        case "ArrowDown":
          e.preventDefault();
          if (!open) openDropdown();
          else selectActive();
          break;
        case "ArrowUp":
          e.preventDefault();
          if (!open) openDropdown();
          else setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Escape":
          if (open) {
            e.preventDefault();
            closeDropdown();
          }
          break;
        case "Home":
          if (open) {
            e.preventDefault();
            setActiveIndex(0);
          }
          break;
        case "End":
          if (open) {
            e.preventDefault();
            setActiveIndex(items.length - 1);
          }
          break;
      }
    },
    [disabled, open, openDropdown, selectActive, closeDropdown, items.length],
  );

  // ── browser-preview fallback: plain controlled text input ──
  if (forceTextFallback) {
    return (
      <div>
        <label htmlFor={createElId} className={labelClass}>
          {label}
        </label>
        <input
          id={createElId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={createNewPlaceholder}
          className={inputClass}
          autoComplete="off"
        />
        {helperText && <p className={helperClass}>{helperText}</p>}
      </div>
    );
  }

  // Whether the typed value (create mode) matches an existing option (upsert hint).
  const createMatchesExisting =
    mode === "create" &&
    value.trim().length > 0 &&
    options.some(
      (o) => o.name.toLowerCase() === value.trim().toLowerCase(),
    );

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={fieldId} className={labelClass}>
        {label}
      </label>

      {mode === "pick" ? (
        <>
          <button
            ref={triggerRef}
            id={triggerElId}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={listId}
            aria-activedescendant={open ? optionId(activeIndex) : undefined}
            disabled={disabled}
            onClick={() => (open ? closeDropdown() : openDropdown())}
            onKeyDown={onTriggerKeyDown}
            className={cn(triggerBase, triggerRest)}
          >
            <span
              className={cn(
                "truncate",
                value ? "text-content-primary" : "text-content-muted",
              )}
            >
              {value || placeholder}
            </span>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden
              className={cn(
                "shrink-0 text-content-muted transition-transform duration-200",
                open && "rotate-180",
              )}
            />
          </button>

          {open && (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={label}
              className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-56 animate-fade-in overflow-y-auto rounded-btn border border-glass-border bg-ink-850 p-1 shadow-card-hover scroll-thin"
            >
              {loading && (
                <li className="px-2.5 py-2 text-sm text-content-muted">Loading…</li>
              )}

              {!loading && options.length === 0 && (
                <li className="px-2.5 py-2 text-sm text-content-muted">
                  {emptyHint}
                </li>
              )}

              {!loading &&
                items.map((item, idx) => {
                  const active = idx === activeIndex;

                  if (item.kind === "create") {
                    return (
                      <li key="create-new" role="presentation">
                        <div className="my-1 h-px bg-glass-border" aria-hidden />
                        <button
                          type="button"
                          data-idx={idx}
                          id={optionId(idx)}
                          role="option"
                          aria-selected={active}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={enterCreate}
                          className={cn(
                            itemBase,
                            active
                              ? "bg-lime/10 text-content-primary ring-1 ring-lime/30"
                              : "text-content-secondary hover:bg-white/[0.05] hover:text-content-primary",
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <Plus
                              size={14}
                              strokeWidth={2.25}
                              aria-hidden
                              className="text-lime"
                            />
                            Create new…
                          </span>
                        </button>
                      </li>
                    );
                  }

                  const selected = item.name === value;
                  return (
                    <li key={`opt-${item.id}`} role="presentation">
                      <button
                        type="button"
                        data-idx={idx}
                        id={optionId(idx)}
                        role="option"
                        aria-selected={selected}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() =>
                          pickOption({ id: item.id, name: item.name })
                        }
                        className={cn(
                          itemBase,
                          active
                            ? "bg-lime/10 text-content-primary ring-1 ring-lime/30"
                            : "text-content-secondary hover:bg-white/[0.05] hover:text-content-primary",
                        )}
                      >
                        <span className="truncate">{item.name}</span>
                        {selected && (
                          <Check
                            size={14}
                            strokeWidth={2.5}
                            aria-hidden
                            className="shrink-0 text-lime"
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
            </ul>
          )}
        </>
      ) : (
        // ── create mode: free-text input ──
        <div className="space-y-1.5">
          <input
            ref={createInputRef}
            id={createElId}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={createNewPlaceholder}
            className={inputClass}
            autoComplete="off"
            aria-label={label}
          />
          <button
            type="button"
            onClick={backToPick}
            className="inline-flex items-center gap-1 text-xs text-content-secondary transition-colors hover:text-content-primary"
          >
            <ArrowLeft size={12} strokeWidth={2.25} aria-hidden />
            choose existing
          </button>
          {createMatchesExisting && (
            <p className="text-xs text-lime/90">
              Matches an existing item — it will be reused.
            </p>
          )}
        </div>
      )}

      {helperText && mode === "pick" && (
        <p className={helperClass}>{helperText}</p>
      )}
    </div>
  );
}
