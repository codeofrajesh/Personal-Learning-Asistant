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
                  return (
                    <div
                      key={p.id}
                      className="plugin-card group glass rounded-card shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover"
                    >
                      <div className="flex items-start gap-3">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-btn border border-white/[0.06] bg-white/[0.05]">
                          <Icon className="h-6 w-6 text-lime" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h2 className="truncate text-sm font-semibold text-content-primary">
                              {p.name}
                            </h2>
                            {pinned && (
                              <span className="shrink-0 rounded-full bg-lime/10 px-1.5 py-0.5 text-[0.6rem] font-medium text-lime">
                                Pinned
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-content-muted">
                            {p.description}
                          </p>
                        </div>
                      </div>

                      <div className="mt-4 flex items-center gap-2">
                        {/* Toggle: "Pin to nav" (wired to pinStore). */}
                        <button
                          type="button"
                          onClick={() => setPinned(p.id, !pinned)}
                          aria-pressed={pinned}
                          aria-label={pinned ? `Unpin ${p.name} from nav` : `Pin ${p.name} to nav`}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-btn border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.06]",
                            pinned
                              ? "border-lime/40 bg-lime/10 text-lime"
                              : "border-white/10 text-content-secondary"
                          )}
                        >
                          <Pin size={13} strokeWidth={2} aria-hidden />
                          {pinned ? "Pinned to nav" : "Pin to nav"}
                        </button>

                        {/* Open the plugin's page. */}
                        {primary && (
                          <Link
                            to={primary}
                            className="inline-flex items-center gap-1.5 rounded-btn border border-white/10 px-2.5 py-1.5 text-xs text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary"
                          >
                            Open
                            <ExternalLink size={12} strokeWidth={2} aria-hidden />
                          </Link>
                        )}
                        <span className="ml-auto inline-flex items-center gap-1 text-[0.65rem] text-content-faint">
                          <MoreHorizontal size={13} strokeWidth={2} aria-hidden />
                          v{p.version}
                        </span>
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