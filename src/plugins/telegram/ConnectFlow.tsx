/**
 * ConnectFlow — Telegram login, inline in the plugin page (progressive disclosure).
 *
 * Steps: Phone → Code → Password (2FA, only when Telegram requires it). Calls the real
 * backend via `useAuth`; errors render inline below the field that caused them.
 *
 * The step is derived from the store rather than held only locally, so a 2FA hand-off (which
 * the backend discovers, not the UI) can advance the flow, and a remount mid-login lands on
 * the right step instead of resetting to Phone.
 */

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "./authStore";
import { cn } from "../../lib/utils";

type Step = "phone" | "code" | "password";

const STEPS: { key: Step; label: string }[] = [
  { key: "phone", label: "Phone" },
  { key: "code", label: "Code" },
  { key: "password", label: "Password" },
];

const STEP_INDEX: Record<Step, number> = { phone: 0, code: 1, password: 2 };

export default function ConnectFlow() {
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const passwordHint = useAuth((s) => s.passwordHint);
  const pendingPhone = useAuth((s) => s.pendingPhone);
  const hasCredentials = useAuth((s) => s.hasCredentials);
  const requestCode = useAuth((s) => s.requestCode);
  const submitCode = useAuth((s) => s.submitCode);
  const submitPassword = useAuth((s) => s.submitPassword);
  const resetLogin = useAuth((s) => s.resetLogin);

  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // Derived, not stored: 2FA is discovered by the backend, and a code in flight is exactly
  // what `pendingPhone` records — so the step survives a remount.
  const step: Step =
    status === "needs_password" ? "password" : pendingPhone ? "code" : "phone";

  const onPhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await requestCode(phone);
    setBusy(false);
  };

  const onCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await submitCode(code);
    setBusy(false);
    // A rejected code keeps the login alive server-side, so only the field is cleared.
    setCode("");
  };

  const onPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await submitPassword(password);
    setBusy(false);
    setPassword("");
  };

  const startOver = () => {
    setCode("");
    setPassword("");
    resetLogin();
  };

  // Credentials are a hard prerequisite: Telegram will not issue a login code without an
  // api_id/api_hash pair. Saying so here beats letting the user type a phone number and be
  // rejected by the backend for a reason that isn't about their phone number.
  if (!hasCredentials) {
    return (
      <p className="text-sm text-content-muted">
        Add your Telegram API credentials in{" "}
        <span className="text-content-secondary">Settings → Plugins</span> first, then come
        back here to connect.
      </p>
    );
  }

  const inputClass =
    "w-full rounded-btn border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-content-primary outline-none transition-colors focus:border-lime/40";
  const buttonClass =
    "inline-flex items-center gap-2 rounded-btn bg-lime px-5 py-2.5 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] active:scale-[0.98]";

  return (
    <div className="space-y-5">
      {/* Step indicator */}
      <ol className="flex items-center gap-2" aria-label="Login steps">
        {STEPS.map((s, i) => {
          const current = s.key === step;
          const done = STEP_INDEX[s.key] < STEP_INDEX[step];
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span
                aria-current={current ? "step" : undefined}
                className={cn(
                  "grid h-6 w-6 place-items-center rounded-full text-xs font-semibold",
                  done
                    ? "bg-lime/40 text-ink-900"
                    : current
                      ? "bg-lime text-ink-900"
                      : "text-content-faint"
                )}
              >
                {i + 1}
              </span>
              <span
                className={cn(
                  "text-xs",
                  current
                    ? "text-lime"
                    : done
                      ? "text-content-secondary"
                      : "text-content-faint"
                )}
              >
                {s.label}
              </span>
              {i < STEPS.length - 1 && (
                <span className="mx-1 h-px w-4 bg-white/10" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>

      {step === "phone" && (
        <form onSubmit={onPhoneSubmit} className="space-y-3" noValidate>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-content-secondary">
              Phone number
            </span>
            <input
              type="tel"
              autoFocus
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 000 1234"
              autoComplete="tel"
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-content-faint">
              Include your country code. Telegram sends the code to this account.
            </span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-orange">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !phone.trim()}
            className={cn(buttonClass, (busy || !phone.trim()) && "cursor-not-allowed opacity-60")}
          >
            {busy ? "Sending code…" : "Send code"}
          </button>
        </form>
      )}

      {step === "code" && (
        <form onSubmit={onCodeSubmit} className="space-y-3" noValidate>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-content-secondary">
              Login code
            </span>
            <input
              type="text"
              autoFocus
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="12345"
              autoComplete="one-time-code"
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-content-faint">
              Sent to {pendingPhone} — check your other Telegram apps.
            </span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-orange">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !code.trim()}
              className={cn(buttonClass, (busy || !code.trim()) && "cursor-not-allowed opacity-60")}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={startOver}
              className="inline-flex items-center gap-1.5 text-xs text-content-muted transition-colors hover:text-content-secondary"
            >
              <ArrowLeft size={13} strokeWidth={2} aria-hidden />
              Use a different number
            </button>
          </div>
        </form>
      )}

      {step === "password" && (
        <form onSubmit={onPasswordSubmit} className="space-y-3" noValidate>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-content-secondary">
              Two-factor password
            </span>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className={inputClass}
            />
            {passwordHint && (
              <span className="mt-1 block text-xs text-cyan-300">Hint: {passwordHint}</span>
            )}
          </label>
          {error && (
            <p role="alert" className="text-sm text-orange">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !password}
              className={cn(buttonClass, (busy || !password) && "cursor-not-allowed opacity-60")}
            >
              {busy ? "Verifying…" : "Finish"}
            </button>
            <button
              type="button"
              onClick={startOver}
              className="inline-flex items-center gap-1.5 text-xs text-content-muted transition-colors hover:text-content-secondary"
            >
              <ArrowLeft size={13} strokeWidth={2} aria-hidden />
              Start over
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
