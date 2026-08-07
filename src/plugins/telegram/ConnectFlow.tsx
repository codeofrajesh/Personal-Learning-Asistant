import { useState } from "react";
import { ArrowLeft, Send } from "lucide-react";
import { useAuth } from "./authStore";
import { cn } from "../../lib/utils";
import { motion, AnimatePresence } from "framer-motion";

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
    "w-full rounded-btn border border-white/10 bg-white/[0.02] px-4 py-2.5 text-sm text-content-primary outline-none transition-all focus:border-[#2AABEE]/50 focus:bg-[#2AABEE]/[0.02] focus:shadow-[0_0_10px_rgba(42,171,238,0.1)]";
  const buttonClass =
    "inline-flex w-full sm:w-auto justify-center items-center gap-2 rounded-btn bg-[#2AABEE] px-6 py-2.5 text-sm font-semibold text-white shadow-[0_0_15px_rgba(42,171,238,0.3)] transition-transform hover:scale-[1.02] active:scale-[0.98]";

  const slideVariants = {
    enter: (direction: number) => ({
      x: direction > 0 ? 20 : -20,
      opacity: 0,
    }),
    center: {
      zIndex: 1,
      x: 0,
      opacity: 1,
    },
    exit: (direction: number) => ({
      zIndex: 0,
      x: direction < 0 ? 20 : -20,
      opacity: 0,
    }),
  };

  return (
    <div className="space-y-6 max-w-md">
      {/* Step indicator */}
      <ol className="flex items-center gap-3" aria-label="Login steps">
        {STEPS.map((s, i) => {
          const current = s.key === step;
          const done = STEP_INDEX[s.key] < STEP_INDEX[step];
          return (
            <li key={s.key} className="flex items-center gap-3">
              <span
                aria-current={current ? "step" : undefined}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-full text-xs font-semibold transition-all",
                  done
                    ? "bg-[#2AABEE]/30 text-[#2AABEE]"
                    : current
                      ? "bg-[#2AABEE] text-white shadow-[0_0_10px_rgba(42,171,238,0.3)]"
                      : "bg-white/5 text-content-faint"
                )}
              >
                {i + 1}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  current
                    ? "text-content-primary"
                    : done
                      ? "text-[#2AABEE]"
                      : "text-content-faint"
                )}
              >
                {s.label}
              </span>
              {i < STEPS.length - 1 && (
                <span className="mx-2 h-px w-6 bg-white/10" aria-hidden />
              )}
            </li>
          );
        })}
      </ol>

      <div className="relative">
        <AnimatePresence mode="wait" custom={STEP_INDEX[step]}>
          <motion.div
            key={step}
            custom={STEP_INDEX[step]}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="w-full"
          >
            {step === "phone" && (
              <form onSubmit={onPhoneSubmit} className="space-y-4" noValidate>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-content-secondary">
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
                  <span className="mt-2 block text-xs text-content-faint">
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
                  className={cn(buttonClass, (busy || !phone.trim()) && "cursor-not-allowed opacity-60 hover:scale-100")}
                >
                  {busy ? "Sending code…" : "Send code"}
                  {!busy && <Send size={15} strokeWidth={2} />}
                </button>
              </form>
            )}

            {step === "code" && (
              <form onSubmit={onCodeSubmit} className="space-y-4" noValidate>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-content-secondary">
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
                  <span className="mt-2 block text-xs text-content-faint">
                    Sent to <span className="text-content-secondary">{pendingPhone}</span> — check your other Telegram apps.
                  </span>
                </label>
                {error && (
                  <p role="alert" className="text-sm text-orange">
                    {error}
                  </p>
                )}
                <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={startOver}
                    className="inline-flex w-full sm:w-auto justify-center items-center gap-1.5 rounded-btn border border-white/10 px-4 py-2.5 text-sm font-medium text-content-muted transition-colors hover:bg-white/[0.03] hover:text-content-secondary"
                  >
                    <ArrowLeft size={14} strokeWidth={2} aria-hidden />
                    Different number
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !code.trim()}
                    className={cn(buttonClass, (busy || !code.trim()) && "cursor-not-allowed opacity-60 hover:scale-100")}
                  >
                    {busy ? "Signing in…" : "Sign in"}
                  </button>
                </div>
              </form>
            )}

            {step === "password" && (
              <form onSubmit={onPasswordSubmit} className="space-y-4" noValidate>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-content-secondary">
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
                    <span className="mt-2 block text-xs text-[#2AABEE]">Hint: {passwordHint}</span>
                  )}
                </label>
                {error && (
                  <p role="alert" className="text-sm text-orange">
                    {error}
                  </p>
                )}
                <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={startOver}
                    className="inline-flex w-full sm:w-auto justify-center items-center gap-1.5 rounded-btn border border-white/10 px-4 py-2.5 text-sm font-medium text-content-muted transition-colors hover:bg-white/[0.03] hover:text-content-secondary"
                  >
                    <ArrowLeft size={14} strokeWidth={2} aria-hidden />
                    Start over
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !password}
                    className={cn(buttonClass, (busy || !password) && "cursor-not-allowed opacity-60 hover:scale-100")}
                  >
                    {busy ? "Verifying…" : "Finish login"}
                  </button>
                </div>
              </form>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
