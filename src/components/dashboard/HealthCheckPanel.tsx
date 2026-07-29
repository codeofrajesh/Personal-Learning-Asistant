/**
 * Backend connectivity panel.
 *
 * Calls the `health_check` IPC command and reports the result — this is the visible
 * proof of the React → Tauri → Rust → SQLite (write) → (read) → back roundtrip
 * (design.md Section 14, step 3). Runs once on mount and offers a manual re-check.
 *
 * Degrades gracefully in a plain browser (outside the Tauri shell): instead of
 * throwing on the missing IPC bridge, it shows a neutral "preview mode" state.
 */

import { useCallback, useEffect, useState } from "react";
import { ipc, isTauri, NotInTauriError } from "../../lib/ipc";
import type { HealthReport } from "../../lib/types";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; report: HealthReport }
  | { kind: "preview" } // running outside Tauri (browser preview)
  | { kind: "error"; message: string };

export default function HealthCheckPanel() {
  const [state, setState] = useState<State>({ kind: "idle" });

  const check = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "preview" });
      return;
    }
    setState({ kind: "checking" });
    try {
      // Token echoed back by the backend confirms the write+read path.
      const report = await ipc.healthCheck("roundtrip-ok");
      setState({ kind: "ok", report });
    } catch (err) {
      const message =
        err instanceof NotInTauriError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const dot =
    state.kind === "ok"
      ? "bg-lime shadow-glow-lime"
      : state.kind === "error"
        ? "bg-orange"
        : "bg-content-muted";

  return (
    <section
      aria-label="Backend status"
      className="glass rounded-card p-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden="true" />
          <h2 className="text-sm font-semibold text-content-primary">Backend</h2>
        </div>
        <button
          type="button"
          onClick={() => void check()}
          disabled={state.kind === "checking"}
          className="rounded-btn border border-glass-border px-2.5 py-1 text-xs text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary disabled:opacity-50"
        >
          {state.kind === "checking" ? "Checking…" : "Re-check"}
        </button>
      </div>

      <div className="mt-3 text-sm">
        {state.kind === "ok" && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-content-secondary">
            <dt className="text-content-muted">Roundtrip</dt>
            <dd className="font-medium text-lime">echo “{state.report.echo}”</dd>
            <dt className="text-content-muted">Goals in DB</dt>
            <dd className="text-content-primary">{state.report.goal_count}</dd>
            <dt className="text-content-muted">Backend version</dt>
            <dd className="text-content-primary">v{state.report.version}</dd>
          </dl>
        )}
        {state.kind === "checking" && (
          <p className="text-content-muted">Contacting Rust backend…</p>
        )}
        {state.kind === "preview" && (
          <p className="text-content-muted">
            Preview mode — open inside the desktop app to reach the backend.
          </p>
        )}
        {state.kind === "error" && (
          <p className="text-orange">IPC failed: {state.message}</p>
        )}
        {state.kind === "idle" && <p className="text-content-muted">Not checked yet.</p>}
      </div>
    </section>
  );
}
