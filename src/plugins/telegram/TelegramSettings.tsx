/**
 * TelegramSettings — the plugin's contributed Settings section (`Settings → Plugins`).
 *
 * This is where `api_id` / `api_hash` live. Telegram requires every third-party client to
 * use the developer's own credentials, so this form is a hard prerequisite for connecting;
 * it is rendered inside the plugin card list via the manifest's `settingsSections`
 * contribution, so the Settings page never imports Telegram directly.
 *
 * The hash is write-only by design: the backend returns whether one is stored, never the
 * value, so a saved secret can't be read back out of the UI.
 */

import { useEffect, useState } from "react";
import { KeyRound, ExternalLink } from "lucide-react";
import { useAuth } from "./authStore";
import { tg } from "./api";
import { cn } from "../../lib/utils";

export default function TelegramSettings() {
  const hasCredentials = useAuth((s) => s.hasCredentials);
  const saveCredentials = useAuth((s) => s.saveCredentials);
  const error = useAuth((s) => s.error);

  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Prefill the api_id (not a secret) so re-saving doesn't mean retyping both fields.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const creds = await tg.getCredentials();
        if (!cancelled) setApiId(creds.api_id);
      } catch {
        /* outside Tauri: leave the field empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    const ok = await saveCredentials(apiId, apiHash);
    setBusy(false);
    if (ok) {
      setSaved(true);
      // Clear the secret from component state once it's stored.
      setApiHash("");
    }
  };

  const inputClass =
    "w-full rounded-btn border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-content-primary outline-none transition-colors focus:border-lime/40";

  return (
    <div className="rounded-btn bg-white/[0.03] p-4">
      <div className="flex items-center gap-2">
        <KeyRound size={15} strokeWidth={2} className="text-lime" aria-hidden />
        <h4 className="text-sm font-semibold text-content-primary">Telegram API credentials</h4>
        {hasCredentials && (
          <span className="rounded-full border border-lime/30 bg-lime/10 px-2 py-0.5 text-[11px] font-medium text-lime">
            Saved
          </span>
        )}
      </div>

      <p className="mt-1.5 text-xs text-content-muted">
        Telegram requires each app to use its own API keys. Create one for yourself at{" "}
        <a
          href="https://my.telegram.org/apps"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-cyan-300 underline decoration-cyan-300/30 underline-offset-2 hover:decoration-cyan-300"
        >
          my.telegram.org/apps
          <ExternalLink size={11} strokeWidth={2} aria-hidden />
        </a>
        , then paste the two values here. They're stored locally and never leave your machine.
      </p>

      <form onSubmit={onSubmit} className="mt-4 space-y-3" noValidate>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content-secondary">api_id</span>
          <input
            value={apiId}
            onChange={(e) => setApiId(e.target.value)}
            inputMode="numeric"
            placeholder="1234567"
            autoComplete="off"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-content-secondary">
            api_hash
            {hasCredentials && (
              <span className="ml-1 font-normal text-content-faint">
                — leave blank to keep the saved one
              </span>
            )}
          </span>
          <input
            value={apiHash}
            onChange={(e) => setApiHash(e.target.value)}
            type="password"
            placeholder={hasCredentials ? "••••••••••••••••••••••••••••••••" : "32-character hex"}
            autoComplete="off"
            spellCheck={false}
            className={cn(inputClass, "font-mono")}
          />
        </label>

        {error && (
          <p role="alert" className="text-xs text-orange">
            {error}
          </p>
        )}
        {saved && !error && (
          <p aria-live="polite" className="text-xs text-lime">
            Credentials saved. You can connect your account now.
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !apiId.trim() || !apiHash.trim()}
          className={cn(
            "inline-flex items-center gap-2 rounded-btn border border-white/10 px-3 py-2 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary",
            (busy || !apiId.trim() || !apiHash.trim()) && "cursor-not-allowed opacity-50"
          )}
        >
          {busy ? "Saving…" : hasCredentials ? "Update credentials" : "Save credentials"}
        </button>
      </form>
    </div>
  );
}
