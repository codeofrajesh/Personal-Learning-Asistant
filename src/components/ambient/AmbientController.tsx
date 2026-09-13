/**
 * AmbientController — headless. Mounted once in AppShell so it lives for the whole session
 * (surviving route changes, including into/out of the player). Its only job is to drive the
 * sleep-timer countdown: a 1 s tick while a timer is armed, which the store turns into the
 * remaining-time display and the exponential fade-out. Renders nothing.
 */

import { useEffect } from "react";
import { useAmbientStore } from "../../lib/ambient/useAmbientStore";

export default function AmbientController() {
  const sleepEndsAt = useAmbientStore((s) => s.sleepEndsAt);
  const tickSleep = useAmbientStore((s) => s.tickSleep);

  useEffect(() => {
    if (sleepEndsAt == null) return;
    // Tick immediately so the display doesn't wait a second, then every second.
    tickSleep();
    const id = window.setInterval(() => tickSleep(), 1000);
    return () => window.clearInterval(id);
  }, [sleepEndsAt, tickSleep]);

  return null;
}
