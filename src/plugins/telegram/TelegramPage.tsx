/**
 * Telegram plugin page — `/plugins/telegram`.
 *
 * Phase 2: honest empty state with a **disabled** Connect button.
 * The auth flow (request code → code input → 2FA → "Connected as @user") is Phase 3.
 * This page loads only when visited (code-split per the app's Section 15 rule).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { SendHorizontal, MessageSquare, Link as LinkIcon, UserPlus, HelpCircle } from "lucide-react";
import Breadcrumb from "../../components/layout/Breadcrumb";
import type { PluginStatus } from "../../lib/plugins/statusDot";
import { cn } from "../../lib/utils";

export default function TelegramPage() {
  // Placeholder for Phase 3 authStore status — for now it's always "disconnected".
  // Phase 3 will replace this with `useAuthStore((s) => s.status)` (which returns the
  // union, so the disconnected/connected comparisons below will resolve normally).
  // The cast widens the literal so the comparisons don't narrow-trip TypeScript.
  const status = "disconnected" as PluginStatus;

  // Demo local state for the Connect button click (Phase 3: replaced by authStore actions).
  const [connecting, setConnecting] = useState(false);

  // Guard against double-click while the (future) flow is running.
  const onConnect = () => {
    setConnecting(true);
    // Phase 3: await authStore.requestCode(phone) + code input + sign in
    setTimeout(() => setConnecting(false), 300);
  };

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

        {/* Status strip */}
        <div className="mb-8 flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn(
              "h-2 w-2 rounded-full",
              status === "connected" ? "bg-lime shadow-glow-lime" : "bg-white/15"
            )}
          />
          <span className="text-content-secondary">
            {status === "connected" ? "Connected — media is ready to import." : "Not connected."}
          </span>
        </div>

        {/* Empty state: banner card + two "coming in a later phase" feature exposes */}
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
            <button
              type="button"
              onClick={onConnect}
              disabled={status === "connected"}
              title={status === "connected" ? "Already connected" : "Connection is a later phase"}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-btn border px-4 py-2.5 text-sm font-semibold shadow-glow-lime transition-transform hover:scale-[1.02]",
                status === "connected"
                  ? "cursor-not-allowed border-lime/40 bg-lime/10 text-lime opacity-60"
                  : "border-lime/40 bg-lime/10 text-lime"
              )}
            >
              <UserPlus size={16} strokeWidth={2} aria-hidden />
              {connecting ? "Waiting…" : "Connect"}
              {status !== "connected" && <span className="text-[0.65rem] font-normal text-content-faint">soon</span>}
            </button>
          </div>
        </div>

        {/* Feature exposes (placeholder grid for Phase 4/5 content) */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="glass rounded-card p-card shadow-card">
            <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
              <MessageSquare size={16} strokeWidth={2} className="text-lime" aria-hidden />
              Channels
            </div>
            <p className="mt-1.5 text-sm text-content-muted">
              Browse a channel's recent media and import lessons with one click.
            </p>
          </div>
          <div className="glass rounded-card p-card shadow-card">
            <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
              <LinkIcon size={16} strokeWidth={2} className="text-lime" aria-hidden />
              Import link
            </div>
            <p className="mt-1.5 text-sm text-content-muted">
              Paste a <span className="font-mono text-xs">t.me/c/…</span> link to pull a specific
              lesson into your library.
            </p>
          </div>
        </div>

        <p className="mt-6 flex items-center gap-1.5 text-xs text-content-faint">
          <HelpCircle size={13} strokeWidth={2} aria-hidden />
          Telegram access is read-only. Low ban risk, documented in-app. Link importing and
          streaming arrive in a later phase.
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