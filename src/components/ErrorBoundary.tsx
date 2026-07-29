/**
 * Top-level error boundary.
 *
 * Without this, a throw during React render unmounts the whole tree → blank white
 * screen with no clue what broke. This boundary catches the error and renders it
 * inline (message + stack) so the cause is visible instead of a white screen, and
 * offers a Reload button. It's a development/diagnostic aid that stays useful in
 * production (a graceful crash screen beats a silent white page).
 *
 * Note: error boundaries must be class components — `getDerivedStateFromError` /
 * `componentDidCatch` have no hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] app crashed:", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    return (
      <div
        style={{
          padding: "24px",
          color: "#F4F4F5",
          background: "#0D0D0D",
          minHeight: "100vh",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "13px",
          whiteSpace: "pre-wrap",
          overflow: "auto",
        }}
      >
        <h2 style={{ color: "#AAFF00", margin: "0 0 12px", fontFamily: "inherit" }}>
          PLE hit an error
        </h2>
        <p style={{ color: "#FF6B35", margin: "0 0 16px" }}>{err.message}</p>
        <pre style={{ margin: 0, color: "#A1A1AA", fontSize: "11px", lineHeight: 1.5 }}>
          {err.stack ?? "(no stack)"}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: "16px",
            padding: "8px 14px",
            background: "#AAFF00",
            color: "#0D0D0D",
            border: "none",
            borderRadius: "8px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
