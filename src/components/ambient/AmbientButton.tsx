/**
 * AmbientButton — the 🎧 Focus Audio trigger + its popover. Reused in two places:
 *  - the global top bar (`variant="topbar"`, popover drops below, aligns right), and
 *  - the mpv player control bar (`variant="player"`, popover opens upward, aligns left over video).
 *
 * A small lime dot marks the button while ambient audio is playing. Closes on outside-click and
 * Escape. The popover itself is opaque (#0a0e1a), so it's safe over the transparent player window.
 */

import { useEffect, useRef } from "react";
import { Headphones } from "lucide-react";
import { useAmbientStore } from "../../lib/ambient/useAmbientStore";

interface Props {
  variant?: "topbar" | "player";
  onOpenChange?: (open: boolean) => void;
}

export default function AmbientButton({ variant = "topbar", onOpenChange }: Props) {
  const isPlaying = useAmbientStore((s) => s.isPlaying);
  const isDrawerOpen = useAmbientStore((s) => s.isDrawerOpen);
  const toggleDrawer = useAmbientStore((s) => s.toggleDrawer);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onOpenChange?.(isDrawerOpen);
  }, [isDrawerOpen, onOpenChange]);

  const isPlayer = variant === "player";
  const buttonClass = isPlayer
    ? "relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 " +
      (isDrawerOpen || isPlaying
        ? "text-lime hover:bg-white/[0.1]"
        : "text-content-secondary hover:bg-white/[0.1] hover:text-content-primary")
    : "relative grid h-9 w-9 place-items-center rounded-full transition-colors " +
      (isDrawerOpen || isPlaying
        ? "text-lime hover:bg-white/[0.06]"
        : "text-content-secondary hover:bg-white/[0.06] hover:text-content-primary");

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleDrawer}
        className={buttonClass}
        aria-label="Focus audio"
        aria-expanded={isDrawerOpen}
        title="Focus audio — YouTube, ambient sounds & sleep timer"
      >
        <Headphones size={isPlayer ? 18 : 16} />
        {isPlaying && (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-lime shadow-glow-lime" />
        )}
      </button>
    </div>
  );
}
