import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { applyPerfClassEarly } from "./lib/perfStore";
import "./index.css";

// Resolve the performance tier and stamp data-perf onto <html> BEFORE React mounts, so the
// very first paint already reflects the tier (no flash of the heavy glass finish on weak GPUs).
applyPerfClassEarly();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
