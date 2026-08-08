import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Send, QrCode, Smartphone, RefreshCw, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useAuth } from "./authStore";
import { cn } from "../../lib/utils";
import { motion, AnimatePresence } from "framer-motion";

type Step = "choose" | "phone" | "code" | "qr" | "password";

const STEPS: { key: Step; label: string }[] = [
  { key: "phone", label: "Phone" },
  { key: "code", label: "Code" },
  { key: "qr", label: "QR Code" },
  { key: "password", label: "Password" },
];

const STEP_INDEX: Record<Step, number> = {
  choose: 0,
  phone: 1,
  code: 2,
  qr: 2,
  password: 3,
};

export default function ConnectFlow() {
  const status = useAuth((s) => s.status);
  const error = useAuth((s) => s.error);
  const passwordHint = useAuth((s) => s.passwordHint);
  const pendingPhone = useAuth((s) => s.pendingPhone);
  const qrToken = useAuth((s) => s.qrToken);
  const qrExpiresIn = useAuth((s) => s.qrExpiresIn);
  const qrPolling = useAuth((s) => s.qrPolling);
  const hasCredentials = useAuth((s) => s.hasCredentials);
  const requestCode = useAuth((s) => s.requestCode);
  const submitCode = useAuth((s) => s.submitCode);
  const submitPassword = useAuth((s) => s.submitPassword);
  const startQrPoll = useAuth((s) => s.startQrPoll);
  const stopQrPoll = useAuth((s) => s.stopQrPoll);
  const resetLogin = useAuth((s) => s.resetLogin);

  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualStep, setManualStep] = useState<Step | null>(null);
  const qrStartedRef = useRef(false);

  // The effective step: 2FA always shows the password step; otherwise the user's manual
  // choice or the derived phone-flow step.
  const step: Step =
    status === "needs_password"
      ? "password"
      : manualStep ?? (pendingPhone ? "code" : "choose");

  // Stop the QR poll when the component unmounts or the user navigates away from QR.
  useEffect(() => {
    return () => stopQrPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-start the QR poll the moment the user picks QR.
  useEffect(() => {
    if (step === "qr" && !qrStartedRef.current) {
      qrStartedRef.current = true;
      void startQrPoll();
    }
    if (step !== "qr") {
      qrStartedRef.current = false;
      stopQrPoll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const onPhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const success = await requestCode(phone);
    setBusy(false);
    if (success) {
      setManualStep(null);
    }
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

  const refreshQr = () => {
    stopQrPoll();
    qrStartedRef.current = false;
    setManualStep("qr");
    void startQrPoll();
  };

  const startOver = () => {
    setCode("");
    setPassword("");
    setManualStep(null);
    stopQrPoll();
    qrStartedRef.current = false;
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
  const ghostClass =
    "inline-flex w-full sm:w-auto justify-center items-center gap-1.5 rounded-btn border border-white/10 px-4 py-2.5 text-sm font-medium text-content-muted transition-colors hover:bg-white/[0.03] hover:text-content-secondary";

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
      {/* Step indicator — hidden on the "choose" screen */}
      {step !== "choose" && (
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
      )}

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
            {/* ── Method choice ─────────────────────────────────────────────── */}
            {step === "choose" && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setManualStep("qr")}
                  className="group flex w-full items-center gap-3 rounded-btn border border-[#2AABEE]/25 bg-[#2AABEE]/[0.06] p-4 text-left transition-all hover:border-[#2AABEE]/50 hover:bg-[#2AABEE]/[0.1]"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#2AABEE]/15 text-[#2AABEE]">
                    <QrCode size={18} strokeWidth={2} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-semibold text-content-primary">
                      Log in with QR Code
                      <span className="rounded-full bg-lime/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-lime">
                        Recommended
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-content-muted">
                      Scan with your phone — no password typing, instant.
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setManualStep("phone")}
                  className="group flex w-full items-center gap-3 rounded-btn border border-white/10 bg-white/[0.02] p-4 text-left transition-all hover:bg-white/[0.05]"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-content-secondary">
                    <Smartphone size={18} strokeWidth={2} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-content-primary">
                      Log in with Phone Number
                    </span>
                    <span className="mt-0.5 block text-xs text-content-muted">
                      Enter your number and the SMS code.
                    </span>
                  </span>
                </button>

                {error && (
                  <p role="alert" className="text-sm text-orange">
                    {error}
                  </p>
                )}
              </div>
            )}

            {/* ── Phone ────────────────────────────────────────────────────── */}
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
                <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setManualStep("choose")}
                    className={ghostClass}
                  >
                    <ArrowLeft size={14} strokeWidth={2} aria-hidden />
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !phone.trim()}
                    className={cn(buttonClass, (busy || !phone.trim()) && "cursor-not-allowed opacity-60 hover:scale-100")}
                  >
                    {busy ? "Sending code…" : "Send code"}
                    {!busy && <Send size={15} strokeWidth={2} />}
                  </button>
                </div>
              </form>
            )}

            {/* ── Code ─────────────────────────────────────────────────────── */}
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
                    className={ghostClass}
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

            {/* ── QR ───────────────────────────────────────────────────────── */}
            {step === "qr" && (
              <div className="space-y-4">
                <div className="flex flex-col items-center">
                  <div className="relative rounded-2xl border border-[#2AABEE]/25 bg-white p-4 shadow-[0_0_30px_rgba(42,171,238,0.15)]">
                    {qrToken ? (
                      <div className="relative">
                        <QRCodeSVG
                          value={`tg://login?token=${qrToken}`}
                          size={208}
                          level="M"
                          marginSize={0}
                          fgColor="#0f172a"
                          bgColor="#ffffff"
                        />
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-black/5"
                        />
                      </div>
                    ) : (
                      <div className="grid h-[208px] w-[208px] place-items-center text-content-faint">
                        {error ? (
                          <p className="px-4 text-center text-xs">{error}</p>
                        ) : (
                          <RefreshCw size={28} strokeWidth={2} className="animate-spin" />
                        )}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex items-center gap-2 text-xs text-content-muted">
                    {qrPolling ? (
                      <>
                        <RefreshCw size={12} strokeWidth={2} className="animate-spin text-[#2AABEE]" aria-hidden />
                        <span>
                          Live — expires in{" "}
                          <span className="font-semibold text-content-secondary">
                            {qrExpiresIn != null ? `${Math.max(0, qrExpiresIn)}s` : "…"}
                          </span>
                        </span>
                      </>
                    ) : qrExpiresIn === 0 ? (
                      <span className="font-semibold text-orange">QR Code Expired</span>
                    ) : (
                      <span>Starting…</span>
                    )}
                  </div>

                  <ol className="mt-4 w-full max-w-xs space-y-1.5 text-left text-xs text-content-muted">
                    <li className="flex gap-2">
                      <span className="text-[#2AABEE] font-semibold">1.</span>
                      Open <span className="text-content-secondary">Telegram</span> on your phone.
                    </li>
                    <li className="flex gap-2">
                      <span className="text-[#2AABEE] font-semibold">2.</span>
                      Go to <span className="text-content-secondary">Settings → Devices → Link Desktop Device</span>.
                    </li>
                    <li className="flex gap-2">
                      <span className="text-[#2AABEE] font-semibold">3.</span>
                      Scan this code and confirm.
                    </li>
                  </ol>
                </div>

                {/* 2FA note — visible even before the poll trips it */}
                <div className="flex items-start gap-2 rounded-btn border border-[#2AABEE]/15 bg-[#2AABEE]/[0.04] p-2.5">
                  <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[#2AABEE]" aria-hidden />
                  <p className="text-xs text-content-muted">
                    If your account has two-step verification, you'll be asked for the password
                    after scanning.
                  </p>
                </div>

                {error && (
                  <p role="alert" className="text-sm text-orange">
                    {error}
                  </p>
                )}

                <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={startOver}
                    className={ghostClass}
                  >
                    <ArrowLeft size={14} strokeWidth={2} aria-hidden />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={refreshQr}
                    className={cn(buttonClass)}
                  >
                    <RefreshCw size={15} strokeWidth={2} />
                    {qrExpiresIn === 0 ? "Get a new code" : "Refresh QR"}
                  </button>
                </div>
              </div>
            )}

            {/* ── Password (2FA) ───────────────────────────────────────────── */}
            {step === "password" && (
              <form onSubmit={onPasswordSubmit} className="space-y-4" noValidate>
                <div className="flex items-start gap-2 rounded-lg border border-[#2AABEE]/15 bg-[#2AABEE]/[0.04] p-2.5">
                  <ShieldCheck size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[#2AABEE]" aria-hidden />
                  <p className="text-xs text-content-muted">
                    This account has two-step verification. Enter the password to finish
                    signing in.
                  </p>
                </div>
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
                    className={ghostClass}
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