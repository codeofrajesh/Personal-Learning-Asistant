/**
 * AmbientButton — the 🎧 Focus Audio trigger + its popover. Reused in two places:
 *  - the global top bar (`variant="topbar"`, popover drops below, aligns right), and
 *  - the mpv player control bar (`variant="player"`, popover opens upward, aligns left over video).
 *
 * A small lime dot marks the button while ambient audio is playing. Closes on outside-click and
 * Escape. The popover itself is opaque (#0a0e1a), so it's safe over the transparent player window.
 */

import { useEffect, useRef, useState } from "react";
import { Headphones } from "lucide-react";
import { useAmbientStore } from "../../lib/ambient/useAmbientStore";
import AmbientPopover from "./AmbientPopover";

interface Props {
  variant?: "topbar" | "player";
  onOpenChange?: (open: boolean) => void;
}

export default function AmbientButton({ variant = "topbar", onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const isPlaying = useAmbientStore((s) => s.isPlaying);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // If clicking within trigger button, toggle handles it
      if (ref.current && ref.current.contains(target)) return;
      // If clicking within portal popover, keep it open
      const popoverEl = document.getElementById("amb-popover-portal");
      if (popoverEl && popoverEl.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isPlayer = variant === "player";
  const buttonClass = isPlayer
    ? "relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 " +
      (open || isPlaying
        ? "text-lime hover:bg-white/[0.1]"
        : "text-content-secondary hover:bg-white/[0.1] hover:text-content-primary")
    : "relative grid h-9 w-9 place-items-center rounded-full transition-colors " +
      (open || isPlaying
        ? "text-lime hover:bg-white/[0.06]"
        : "text-content-secondary hover:bg-white/[0.06] hover:text-content-primary");

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={buttonClass}
        aria-label="Focus audio"
        aria-expanded={open}
        title="Focus audio — ambient sounds & sleep timer"
      >
        <Headphones size={isPlayer ? 18 : 16} />
        {isPlaying && (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-lime shadow-glow-lime" />
        )}
      </button>
      {open && (
        <AmbientPopover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          placement={isPlayer ? "top" : "bottom"}
          align={isPlayer ? "left" : "right"}
        />
      )}
    </div>
  );
}
