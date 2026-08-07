/**
 * PluginsPage — the `/plugins` hub.
 *
 * A card grid of installed (non-core) plugins, each showing identity, status, and two
 * controls backed by the persisted pin store:
 *   · **Enable** — reserved for Phase 3+ capability gating. Phase 1 renders it as a
 *     non-functional "shipped soon" affordance so the hub is honest about what's wired.
 *   · **Pin to nav** — toggles the plugin's presence in the primary sidebar. Persisted via
 *     `pinStore` (DB `plugins.<id>.pinned`).
 *
 * Uses the app's glass-card design DNA (token-matched): `.glass`, `rounded-card`,
 * `shadow-card`, the lime accent, and a GSAP stagger entrance gated on `motionAllowed()`.
 * Skeleton cards match the final card shape while the pin state hydrates (no spinner).
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Pin, ExternalLink, MoreHorizontal } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { motionAllowed } from "../lib/perfStore";
import { pinnablePlugins } from "../lib/plugins/registry";
import { usePins } from "../lib/plugins/pinStore";
import { cn } from "../lib/utils";
import { motion } from "framer-motion";
import Breadcrumb from "../components/layout/Breadcrumb";

/** Skeleton mirror of a plugin card (shape-matched, no data). */
function SkeletonCard() {
  return (
    <div className="glass rounded-card shadow-card p-4">
      <div className="flex items-start gap-3">
        <div className="h-11 w-11 shrink-0 animate-pulse rounded-btn bg-white/[0.06]" />
        <div className="min-w-0 flex-1">
          <div className="h-4 w-28 animate-pulse rounded bg-white/[0.08]" />
          <div className="mt-2 h-3 w-full animate-pulse rounded bg-white/[0.05]" />
          <div className="mt-1 h-3 w-2/3 animate-pulse rounded bg-white/[0.05]" />
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <div className="h-7 w-16 animate-pulse rounded-btn bg-white/[0.06]" />
        <div className="h-7 w-24 animate-pulse rounded-btn bg-white/[0.06]" />
      </div>
    </div>
  );
}

export default function PluginsPage() {
  const plugins = pinnablePlugins();
  const pins = usePins((s) => s.pins);
  const hydrated = usePins((s) => s.hydrated);
  const setPinned = usePins((s) => s.setPinned);

  const [loading, setLoading] = useState(!hydrated);
  useEffect(() => {
    if (hydrated) setLoading(false);
  }, [hydrated]);

  const gridRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (!motionAllowed()) return;
      gsap.fromTo(
        ".plugin-card",
        { y: 14, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, stagger: 0.05, duration: 0.45, ease: "power3.out", overwrite: true }
      );
    },
    { scope: gridRef, dependencies: [loading, pins] }
  );

  return (
    <div className="min-h-full px-6 pb-10">
      <div className="mx-auto max-w-6xl">
        <Breadcrumb items={[{ label: "Plugins" }]} />

        <header className="mb-6 mt-3">
          <h1 className="font-display text-2xl font-bold text-content-primary">Plugins</h1>
          <p className="mt-1 text-sm text-content-muted">
            Tools you can add to PLE. Pinned tools appear in the sidebar; manage them here or in
            Settings.
          </p>
        </header>

        {plugins.length === 0 && !loading ? (
          <div className="glass rounded-card p-10 text-center">
            <p className="text-sm text-content-muted">
              No plugins yet. Tools you install (like Telegram video streaming) will appear here.
            </p>
          </div>
        ) : (
          <div ref={gridRef} className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {loading
              ? Array.from({ length: 3 }).map((_, i) => <SkeletonCard key={i} />)
              : plugins.map((p) => {
                  const Icon = p.icon;
                  const pinned = pins[p.id] ?? p.nav?.defaultPinned ?? false;
                  const primary = p.routes[0]?.path;
                  const isTelegram = p.id === "telegram";
                  const borderColor = isTelegram ? "border-[#2AABEE]/20" : "border-lime/20";
                  const bgGlow = isTelegram ? "group-hover/card:shadow-[0_20px_40px_rgba(42,171,238,0.15)]" : "group-hover/card:shadow-[0_20px_40px_rgba(163,230,53,0.15)]";

                  return (
                    <div key={p.id} className="relative group/card perspective-1000">
                      {/* Ambient background glow on hover */}
                      <div
                        className={cn(
                          "absolute -inset-0.5 rounded-[1.5rem] opacity-0 blur-xl transition-all duration-700 group-hover/card:opacity-100",
                          isTelegram ? "bg-gradient-to-br from-[#2AABEE]/40 to-transparent" : "bg-gradient-to-br from-lime/40 to-transparent"
                        )}
                      />
                      
                      <div
                        className={cn(
                          "plugin-card relative glass rounded-[1.25rem] p-5 border bg-gradient-to-b from-white/[0.04] to-transparent shadow-[0_8px_30px_rgb(0,0,0,0.12)] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] transition-all duration-300 group-hover/card:-translate-y-1 group-hover/card:bg-white/[0.06]",
                          borderColor,
                          bgGlow
                        )}
                      >
                        <div className="flex items-start gap-4">
                          <div className="relative shrink-0">
                            <div
                              className={cn(
                                "absolute -inset-1 rounded-full opacity-0 blur-md transition-opacity duration-500 group-hover/card:opacity-100",
                                isTelegram ? "bg-[#2AABEE]/50" : "bg-lime/50"
                              )}
                            />
                            <span className="relative grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-black/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
                              <Icon className="h-7 w-7" />
                              <span className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/[0.05]" />
                            </span>
                          </div>
                          
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h2 className="truncate text-base font-bold tracking-tight text-white drop-shadow-md">
                                {p.name}
                              </h2>
                              {pinned && (
                                <span
                                  className={cn(
                                    "shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide shadow-sm",
                                    isTelegram ? "bg-[#2AABEE]/10 border border-[#2AABEE]/20 text-[#2AABEE]" : "bg-lime/10 border border-lime/20 text-lime"
                                  )}
                                >
                                  Pinned
                                </span>
                              )}
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-content-muted transition-colors group-hover/card:text-content-secondary">
                              {p.description}
                            </p>
                          </div>
                        </div>

                      <div className="mt-4 flex items-center gap-2">
                        {/* Toggle: "Pin to nav" (wired to pinStore). */}
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          type="button"
                          onClick={() => setPinned(p.id, !pinned)}
                          aria-pressed={pinned}
                          aria-label={pinned ? `Unpin ${p.name} from nav` : `Pin ${p.name} to nav`}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-btn border px-3 py-1.5 text-xs font-semibold transition-all relative overflow-hidden",
                            pinned
                              ? "border-lime/40 bg-lime/10 text-lime shadow-[0_0_10px_rgba(163,230,53,0.15)]"
                              : "border-white/10 bg-white/[0.03] text-content-secondary hover:text-content-primary hover:bg-white/[0.06]"
                          )}
                        >
                          {pinned && (
                            <motion.div
                              layoutId={`pin-glow-${p.id}`}
                              className="absolute inset-0 bg-lime/10"
                              initial={false}
                              transition={{ type: "spring", stiffness: 300, damping: 20 }}
                            />
                          )}
                          <Pin size={13} strokeWidth={2.5} aria-hidden className="relative z-10" />
                          <span className="relative z-10">{pinned ? "Pinned" : "Pin to nav"}</span>
                        </motion.button>

                        {/* Open the plugin's page. */}
                        {primary && (
                          <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                            <Link
                              to={primary}
                              className="inline-flex items-center gap-1.5 rounded-btn border border-[#2AABEE]/30 bg-[#2AABEE]/10 px-4 py-1.5 text-xs font-semibold text-[#2AABEE] shadow-[0_0_10px_rgba(42,171,238,0.15)] transition-all hover:bg-[#2AABEE]/20 hover:border-[#2AABEE]/50 hover:shadow-[0_0_15px_rgba(42,171,238,0.3)]"
                            >
                              Open
                              <ExternalLink size={13} strokeWidth={2.5} aria-hidden />
                            </Link>
                          </motion.div>
                        )}
                        <span className="ml-auto inline-flex items-center gap-1 text-[0.65rem] text-content-faint">
                          <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
                          v{p.version}
                        </span>
                      </div>
                    </div>
                  </div>
                  );
                })}
          </div>
        )}
      </div>
    </div>
  );
}