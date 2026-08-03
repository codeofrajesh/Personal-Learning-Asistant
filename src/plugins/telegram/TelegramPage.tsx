/**
 * Telegram plugin page — `/plugins/telegram`.
 *
 * Phase 3: real auth via `authStore` + `ConnectFlow`. The page shows a connect
 * hero when disconnected, the account card when connected, and the feature
 * exposes (Channels / Import link) which land in Phase 4/5.
 * Loads only when visited (code-split per the app's Section 15 rule).
 */

import { Link } from "react-router-dom";
import {
  SendHorizontal,
  Link as LinkIcon,
  LogOut,
  HelpCircle,
  KeyRound,
  WifiOff,
} from "lucide-react";
import Breadcrumb from "../../components/layout/Breadcrumb";
import ConnectFlow from "./ConnectFlow";
import LinkImport from "./LinkImport";
import { useAuth } from "./authStore";
import { cn } from "../../lib/utils";

export default function TelegramPage() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const hasCredentials = useAuth((s) => s.hasCredentials);
  const signOut = useAuth((s) => s.signOut);

  // No hydrate-on-mount: the manifest's `init` contribution already ran it at boot, so the
  // state is settled before this page is reachable. Re-running here would spend a network
  // round trip to learn what the nav dot is already showing.

  const connected = status === "connected";
  const displayName =
    user?.first_name || (user?.username ? `@${user.username}` : null) || "your account";

  return (
    <div className="min-h-full px-6 pb-10">
      <div className="mx-auto max-w-3xl">
        <Breadcrumb items={[{ label: "Plugins", to: "/plugins" }, { label: "Telegram" }]} />

        <header className="mb-8 mt-3">
          <div className="flex items-center gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-btn border border-white/[0.06] bg-white/[0.05]">
              <SendHorizontal className="h-7 w-7 text-lime" />
            </span>
            <div>
              <h1 className="font-display text-2xl font-bold text-content-primary">Telegram</h1>
              <p className="mt-0.5 text-sm text-content-muted">
                Stream and import private-channel media from your Telegram account.
              </p>
            </div>
          </div>
        </header>

        {/* Status strip. Each state names a different next action, so they can't collapse
            into one "not connected" line: a missing api_hash, a dropped network and a
            genuine sign-out need different things from the user. */}
        <div className="mb-8 flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 rounded-full",
              connected
                ? "bg-lime shadow-glow-lime"
                : status === "unreachable"
                  ? "bg-orange"
                  : "bg-white/15"
            )}
          />
          <span className="text-content-secondary">
            {connected
              ? "Connected — media is ready to import."
              : status === "unreachable"
                ? "Signed in, but Telegram is unreachable. Check your connection."
                : status === "unknown"
                  ? "Checking connection…"
                  : !hasCredentials
                    ? "Set up your API credentials to get started."
                    : "Not connected."}
          </span>
        </div>

        {status === "unreachable" && (
          <div className="mb-6 flex items-start gap-2.5 rounded-btn border border-orange/30 bg-orange/10 p-3">
            <WifiOff size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-orange" aria-hidden />
            <p className="text-sm text-content-secondary">
              Your session is saved — there's no need to sign in again. This will reconnect on
              its own once Telegram is reachable.
            </p>
          </div>
        )}

        {connected ? (
          <div className="glass rounded-card p-card shadow-card">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-content-primary">
                  Connected as {displayName}
                </h2>
                <p className="mt-1 text-sm text-content-muted">
                  {user?.username ? `@${user.username}` : user?.phone ?? ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void signOut()}
                className="inline-flex shrink-0 items-center gap-2 rounded-btn border border-white/10 px-4 py-2.5 text-sm font-medium text-content-secondary transition-colors hover:border-orange/40 hover:bg-orange/10 hover:text-orange"
              >
                <LogOut size={16} strokeWidth={2} aria-hidden />
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="glass rounded-card p-card shadow-card">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-content-primary">Connect your account</h2>
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

        {/* Import — only reachable once connected, since every path here needs the session. */}
        {connected && (
          <section className="glass mt-6 rounded-card p-card shadow-card">
            <div className="mb-4 flex items-center gap-2">
              <LinkIcon size={16} strokeWidth={2} className="text-lime" aria-hidden />
              <h2 className="text-base font-semibold text-content-primary">Import lessons</h2>
            </div>
            <LinkImport />
          </section>
        )}

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
