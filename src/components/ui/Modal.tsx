/**
 * Reusable glass modal dialog.
 *
 * Design DNA (Section 7): a frosted `.glass` panel over a dimmed, blurred backdrop,
 * neon-lime focus affordances inherited from global styles. Interaction contract
 * (design-taste-frontend a11y + Section 15 SearchModal rules, which apply to any
 * dialog):
 *   - `role="dialog"` + `aria-modal` + labelled by its title.
 *   - Focus moves into the panel on open and is trapped (Tab cycles within).
 *   - Esc closes; clicking the backdrop closes.
 *   - Focus returns to the previously-focused element on close.
 *   - Motion (backdrop fade + panel scale-in) runs via GSAP, gated on
 *     `prefers-reduced-motion` so it is instant for users who ask for less motion.
 *
 * GSAP (not Framer Motion) per the brief's explicit animation-library ban.
 */

import { useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible dialog title; also rendered as the header. */
  title: string;
  /** Optional sub-line under the title. */
  subtitle?: string;
  children: ReactNode;
  /** Optional footer (action buttons). */
  footer?: ReactNode;
  /** Max width utility class; defaults to a comfortable wizard width. */
  widthClass?: string;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  widthClass = "max-w-2xl",
}: ModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Entrance animation + initial focus.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    if (panel && backdrop) {
      if (prefersReducedMotion()) {
        gsap.set([backdrop, panel], { opacity: 1, scale: 1, y: 0 });
      } else {
        gsap.fromTo(backdrop, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: "power2.out" });
        gsap.fromTo(
          panel,
          { opacity: 0, scale: 0.96, y: 8 },
          { opacity: 1, scale: 1, y: 0, duration: 0.26, ease: "power3.out" },
        );
      }
    }

    // Move focus into the panel (first focusable, else the panel itself).
    const first = panel?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel)?.focus();

    return () => {
      // Restore focus to the trigger on close.
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Esc-to-close + focus trap.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null);
        if (focusables.length === 0) return;
        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && active === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && active === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Close only when the backdrop itself (not a child) is pressed.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        className={`glass flex max-h-[85vh] w-full ${widthClass} flex-col rounded-panel shadow-card-hover outline-none`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-glass-border px-6 py-4">
          <div>
            <h2 id={titleId.current} className="text-lg font-bold text-content-primary">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-sm text-content-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-btn text-content-muted transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ✕
            </span>
          </button>
        </header>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-3 border-t border-glass-border px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
