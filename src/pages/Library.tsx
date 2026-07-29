/**
 * Library (all goals) — Section 8, Page 2.
 *
 * The entry point for content: the "Add Folder" button launches the categorization
 * wizard (AddFolderWizard), and the grid shows every registered Goal with rolled-up
 * counts from `list_library`. Full state handling per the design-taste "no bare
 * states" rule: loading skeletons, a composed empty state, and an error state.
 */

import { useCallback, useEffect, useState } from "react";
import Breadcrumb from "../components/layout/Breadcrumb";
import GoalCard from "../components/library/GoalCard";
import { ipc, isTauri, NotInTauriError, onLibraryChanged } from "../lib/ipc";
import { useMaterialManager } from "../lib/materialManagerStore";
import type { GoalSummary } from "../lib/types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; goals: GoalSummary[] }
  | { kind: "preview" } // outside Tauri (browser preview)
  | { kind: "error"; message: string };

export default function Library() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const openAddFolder = useMaterialManager((s) => s.openAddFolder);
  const importNonce = useMaterialManager((s) => s.importNonce);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "preview" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const goals = await ipc.listLibrary();
      setState({ kind: "ready", goals });
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
    void load();
  }, [load]);

  // Live-refresh when a watched folder changes (new/removed/renamed files).
  useEffect(() => {
    let unlisten: () => void = () => {};
    void onLibraryChanged(() => void load()).then((u) => {
      unlisten = u;
    });
    return () => unlisten();
  }, [load]);

  // Refetch after a successful import from the global Add-Folder modal.
  useEffect(() => {
    if (importNonce > 0) void load();
  }, [importNonce, load]);

  const addDisabled = state.kind === "preview";

  return (
    <div className="min-h-full p-6">
    <div className="animate-fade-up mx-auto max-w-6xl">
      <Breadcrumb items={[{ label: "Library" }]} />

      <header className="mb-6 mt-3 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-content-primary">Library</h1>
          <p className="mt-1 text-sm text-content-muted">All your learning goals.</p>
        </div>
        <button
          type="button"
          onClick={openAddFolder}
          disabled={addDisabled}
          title={
            addDisabled
              ? "Open inside the desktop app to add folders"
              : "Register a folder of learning material"
          }
          className="rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] disabled:pointer-events-none disabled:opacity-50"
        >
          ➕ Add Folder
        </button>
      </header>

      {state.kind === "loading" && (
        <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="glass h-32 animate-pulse rounded-card p-card"
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {state.kind === "ready" && state.goals.length > 0 && (
        <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3">
          {state.goals.map((g) => (
            <GoalCard key={g.id} goal={g} />
          ))}
        </div>
      )}

      {state.kind === "ready" && state.goals.length === 0 && (
        <div className="glass flex min-h-52 flex-col items-center justify-center gap-3 rounded-card p-card text-center">
          <div className="text-4xl" aria-hidden="true">
            📚
          </div>
          <div>
            <p className="font-medium text-content-primary">Your library is empty</p>
            <p className="mt-1 text-sm text-content-muted">
              Add a folder of videos, PDFs, or notes to get started.
            </p>
          </div>
          <button
            type="button"
            onClick={openAddFolder}
            className="mt-1 rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02]"
          >
            ➕ Add your first folder
          </button>
        </div>
      )}

      {state.kind === "preview" && (
        <div className="glass grid min-h-40 place-items-center rounded-card p-card text-center text-sm text-content-muted">
          Preview mode — open inside the desktop app to add folders and see your library.
        </div>
      )}

      {state.kind === "error" && (
        <div className="rounded-card border border-orange/30 bg-orange/[0.06] p-card text-sm text-orange">
          Could not load your library: {state.message}
          <button
            type="button"
            onClick={() => void load()}
            className="ml-3 rounded-btn border border-orange/40 px-2.5 py-1 text-xs text-orange transition-colors hover:bg-orange/10"
          >
            Retry
          </button>
        </div>
      )}

    </div>
    </div>
  );
}
