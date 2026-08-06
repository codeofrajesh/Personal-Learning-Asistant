/**
 * Telegram plugin page — `/plugins/telegram`.
 *
 * Premium command center for the plugin: a glassy hero, live connection status, the
 * import station (LinkImport), and a "Your Telegram library" history section that lists
 * everything already imported with one-click resume + progress. History refreshes
 * automatically after each successful import via a bump key — no polling, no events.
 *
 * Backend contract unchanged: the page only reads auth state, renders ConnectFlow, and
 * composes the two import surfaces. The one new IPC surface it touches is the READ-ONLY
 * `tg_import_history` query behind `ImportHistory`.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  SendHorizontal,
  LogOut,
  HelpCircle,
  KeyRound,
  WifiOff,
  ShieldCheck,
  Link as LinkIcon,
} from "lucide-react";
import Breadcrumb from "../../components/layout/Breadcrumb";
import ConnectFlow from "./ConnectFlow";
import LinkImport from "./LinkImport";
import ImportHistory from "./ImportHistory";
import { useAuth } from "./authStore";
import { cn } from "../../lib/utils";

export default function TelegramPage() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const hasCredentials = useAuth((s) => s.hasCredentials);
  const signOut = useAuth((s) => s.signOut);

  // Bumped after every successful import so the history section re-reads its data.
  const [refreshKey, setRefreshKey] = useState(0);

  // No hydrate-on-mount: the manifest's `init` contribution already ran it at boot, so the
  // state is settled before this page is reachable. Re-running here would spend a network
  // round trip to learn what the nav dot is already showing.

  const connected = status === "connected";
  // A session exists when connected OR unreachable — sign-in isn't the thing to fix for an
  // offline student, so the account card (not the connect flow) is the honest surface.
  const hasSession = connected || status === "unreachable";
  const displayName =
    user?.first_name || (user?.username ? `@${user.username}` : null) || "your account";

  const statusText = connected
    ? "Connected — media is ready to import."
    : status === "unreachable"
      ? "Signed in, but Telegram is unreachable right now."
      : status === "unknown"
        ? "Checking connection…"
        : !hasCredentials
          ? "Set up your API credentials to get started."
          : "Connect your account to start importing.";

  return (
    <div className="min-h-full px-6 pb-10">
      <div className="mx-auto max-w-3xl">
        <Breadcrumb items={[{ label: "Plugins", to: "/plugins" }, { label: "Telegram" }]} />

        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <header className="relative mt-3 overflow-hidden rounded-panel glass shadow-card">
          {/* Ambient lime glow behind the tile — perf-tier safe via .perf-blob */}
          <div
            aria-hidden
            className="perf-blob pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-lime/[0.08] blur-[110px]"
          />
          <div className="relative flex flex-col gap-4 p-card sm:flex-row sm:items-center">
            <span
              aria-hidden
              className="relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-lime/25 bg-lime/10 shadow-glow-lime"
            >
              <SendHorizontal className="h-7 w-7 text-lime" strokeWidth={1.9} />
              <span className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/[0.06]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5">
                <h1 className="font-display text-2xl font-bold tracking-tight text-content-primary">
                  Telegram
                </h1>
                {/* Live status pill */}
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide",
                    connected
                      ? "border-lime/30 bg-lime/10 text-lime"
                      : status === "unreachable"
                        ? "border-orange/30 bg-orange/10 text-orange"
                        : "border-white/10 bg-white/[0.04] text-content-faint"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      connected
                        ? "bg-lime shadow-glow-lime"
                        : status === "unreachable"
                          ? "bg-orange"
                          : "bg-white/20"
                    )}
                  />
                  {connected ? "Connected" : status === "unreachable" ? "Offline" : "Idle"}
                </span>
              </div>
              <p className="mt-1 text-sm text-content-muted">
                Stream and import private-channel media straight into your library —
                nothing is uploaded or copied to disk.
              </p>
            </div>

            {/* Header action */}
            {hasSession && (
              <button
                type="button"
                onClick={() => void signOut()}
                className="inline-flex shrink-0 items-center gap-2 rounded-btn border border-white/10 px-3.5 py-2 text-sm font-medium text-content-secondary transition-colors hover:border-orange/40 hover:bg-orange/10 hover:text-orange"
              >
                <LogOut size={15} strokeWidth={2} aria-hidden />
                Disconnect
              </button>
            )}
          </div>
        </header>

        {/* Unreachable notice */}
        {status === "unreachable" && (
          <div className="mt-3 flex items-start gap-2.5 rounded-btn border border-orange/30 bg-orange/10 p-3">
            <WifiOff size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-orange" aria-hidden />
            <p className="text-sm text-content-secondary">
              Your session is saved — there's no need to sign in again. This will reconnect on
              its own once Telegram is reachable.
            </p>
          </div>
        )}

        {/* ── Connected: account + import + history ─────────────────────────── */}
        {hasSession ? (
          <>
            {/* Compact account strip */}
            <div className="glass mt-4 rounded-card p-card shadow-card">
              <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-lime/25 bg-lime/10">
                    <SendHorizontal size={18} strokeWidth={2} className="text-lime" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-content-primary">
                      Connected as {displayName}
                    </p>
                    <p className="truncate text-xs text-content-muted">
                      {user?.username ? `@${user.username}` : user?.phone ?? statusText}
                    </p>
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-content-faint">
                  <ShieldCheck size={13} strokeWidth={2} className="text-lime" aria-hidden />
                  Read-only access
                </span>
              </div>
            </div>

            {/* Import station — only live once the session is confirmed */}
            {connected && (
              <section
                aria-labelledby="tg-import-title"
                className="glass mt-4 rounded-panel p-card shadow-card"
              >
                <div className="mb-4 flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-btn border border-lime/25 bg-lime/10">
                    <LinkIcon size={15} strokeWidth={2} className="text-lime" aria-hidden />
                  </span>
                  <div>
                    <h2 id="tg-import-title" className="font-display text-base font-semibold text-content-primary">
                      Import lessons
                    </h2>
                    <p className="text-xs text-content-muted">
                      From a single message link, or a whole channel.
                    </p>
                  </div>
                </div>
                <LinkImport onImported={() => setRefreshKey((k) => k + 1)} />
              </section>
            )}

            {/* Import history — read-only, refreshed by the bump key above */}
            {connected && <ImportHistory refreshKey={refreshKey} />}
          </>
        ) : (
          /* ── Not connected: connect card ─────────────────────────────────── */
          <div className="glass mt-4 rounded-card p-card shadow-card">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-base font-semibold text-content-primary">
                  Connect your account
                </h2>
                <p className="mt-1 text-sm text-content-muted">
                  Sign in with your own Telegram account to browse channels and stream media
                  straight into PLE. Nothing is uploaded — the app reads from channels you can
                  already access.
                </p>
              </div>
              {!hasCredentials && (
                <Link
                  to="/settings#plugins"
                  className="inline-flex shrink-0 items-center gap-2 rounded-btn border border-white/10 px-4 py-2.5 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary"
                >
                  <KeyRound size={15} strokeWidth={2} aria-hidden />
                  Add credentials
                </Link>
              )}
            </div>
            <div className="mt-5">
              <ConnectFlow />
            </div>
          </div>
        )}

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <p className="mt-6 flex items-center gap-1.5 text-xs text-content-faint">
          <HelpCircle size={13} strokeWidth={2} aria-hidden />
          Telegram access is read-only — nothing is uploaded or posted. Imported lessons stream
          on demand and are not copied to your disk.
        </p>

        <Link
          to="/plugins"
          className="mt-4 inline-flex items-center gap-1.5 rounded-btn border border-white/10 px-3 py-1.5 text-xs text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary"
        >
          ← Back to Plugins
        </Link>
      </div>
    </div>
  );
}
