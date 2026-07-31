/**
 * ToastHost — renders the live toast stack (bottom-right), mounted once in AppShell.
 *
 * Each toast is a glassmorphism card tinted by tone (focus=lime, break=cyan,
 * success=lime, warning=orange, info=neutral) with a GSAP slide+fade enter and a
 * timed auto-dismiss (progress hairline). Reduced-motion gated. Fully accessible:
 * the region is an aria-live polite container; each toast is a `role="status"`.
 *
 * Perf: no polling — toasts are driven by the store; each card owns a single
 * setTimeout for its auto-dismiss, cleared on unmount.
 *
 * Collision: the stack shifts up when the mini-player is docked (also bottom-right, with a
 * transparent clip-path hole punched through AppShell for the mpv surface). See below.
 */

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Timer, Coffee, CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { useToastStore, type Toast, type ToastTone } from "../../lib/toastStore";
import { useMiniPlayer } from "../../lib/miniPlayerStore";
import { cn } from "../../lib/utils";

const TONE: Record<ToastTone, { icon: typeof Info; ring: string; glow: string; bar: string; iconColor: string }> = {
  focus: { icon: Timer, ring: "border-lime/30", glow: "shadow-[0_16px_50px_-12px_rgba(170,255,0,0.35)]", bar: "bg-lime", iconColor: "text-lime" },
  break: { icon: Coffee, ring: "border-cyan-400/30", glow: "shadow-[0_16px_50px_-12px_rgba(34,211,238,0.35)]", bar: "bg-cyan-400", iconColor: "text-cyan-400" },
  success: { icon: CheckCircle2, ring: "border-lime/30", glow: "shadow-[0_16px_50px_-12px_rgba(170,255,0,0.3)]", bar: "bg-lime", iconColor: "text-lime" },
  warning: { icon: AlertTriangle, ring: "border-orange/30", glow: "shadow-[0_16px_50px_-12px_rgba(255,107,53,0.35)]", bar: "bg-orange", iconColor: "text-orange" },
  info: { icon: Info, ring: "border-white/10", glow: "shadow-2xl", bar: "bg-white/40", iconColor: "text-content-secondary" },
};

export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  // The docked mini-player also lives bottom-right, and AppShell punches a transparent
  // clip-path hole through the ambient canvas so mpv (which renders BEHIND the webview) shows
  // through it. A toast sitting over that hole is unreadable — the video is behind it, not the
  // app background — and it also hides the video the student is watching. So when the mini
  // card is docked, lift the stack clear of it. `rect` is null whenever it isn't docked, which
  // is the whole condition; no route sniffing needed.
  const miniRect = useMiniPlayer((s) => s.rect);
  const liftPx = miniRect ? Math.round(miniRect.h + 32) : 0;

  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      style={{ bottom: `${24 + liftPx}px` }}
      className="scroll-thin pointer-events-none fixed right-6 z-[80] flex max-h-[calc(100vh-3rem)] w-[min(26rem,calc(100vw-3rem))] flex-col gap-3 overflow-y-auto transition-[bottom] duration-200"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const tone = TONE[toast.tone];
  const Icon = tone.icon;

  // Enter animation + auto-dismiss timer + progress bar.
  useEffect(() => {
    const el = ref.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (el && !reduced) {
      gsap.fromTo(
        el,
        { x: 40, opacity: 0, scale: 0.96 },
        { x: 0, opacity: 1, scale: 1, duration: 0.4, ease: "power3.out" },
      );
    }
    let timer: number | undefined;
    if (toast.duration > 0) {
      if (barRef.current && !reduced) {
        gsap.fromTo(
          barRef.current,
          { scaleX: 1 },
          { scaleX: 0, duration: toast.duration / 1000, ease: "none" },
        );
      }
      timer = window.setTimeout(() => close(), toast.duration);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    const el = ref.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (el && !reduced) {
      gsap.to(el, {
        x: 40,
        opacity: 0,
        scale: 0.96,
        duration: 0.28,
        ease: "power2.in",
        onComplete: onDismiss,
      });
    } else {
      onDismiss();
    }
  };

  return (
    <div
      ref={ref}
      role="status"
      className={cn(
        "pointer-events-auto relative overflow-hidden rounded-[20px] border bg-ink-850/80 p-5 backdrop-blur-xl",
        tone.ring,
        tone.glow,
        "[box-shadow:inset_0_1px_1px_rgba(255,255,255,0.06)]",
      )}
    >
      <div className="flex items-start gap-3.5">
        <span className={cn("mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full border bg-white/[0.03]", tone.ring)}>
          <Icon size={20} strokeWidth={2} className={tone.iconColor} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.95rem] font-semibold text-content-primary">{toast.title}</p>
          {toast.body && <p className="mt-1 text-sm leading-relaxed text-content-secondary">{toast.body}</p>}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                close();
              }}
              className={cn("mt-2.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors", tone.ring, tone.iconColor, "hover:bg-white/[0.06]")}
            >
              {toast.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Dismiss"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/30 transition-colors hover:bg-white/[0.06] hover:text-content-primary"
        >
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
      {toast.duration > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/5">
          <div ref={barRef} className={cn("h-full origin-left", tone.bar)} style={{ transform: "scaleX(1)" }} />
        </div>
      )}
    </div>
  );
}
