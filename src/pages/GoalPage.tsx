/**
 * Goal page (Section 8, Page 3): a goal's subjects grid.
 *
 * One `ipc.goalView(id)` round-trip returns the goal header (for the breadcrumb + title)
 * and its subjects with rolled-up counts. Full state handling mirrors `Library.tsx`
 * (loading skeletons / ready / browser-preview / error+retry) — the shared "no bare
 * states" rule.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Breadcrumb from "../components/layout/Breadcrumb";
import BackButton from "../components/layout/BackButton";
import SubjectCard from "../components/library/SubjectCard";
import { ipc, isTauri, NotInTauriError } from "../lib/ipc";
import type { GoalView } from "../lib/types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; view: GoalView }
  | { kind: "preview" }
  | { kind: "error"; message: string };

export default function GoalPage() {
  const { goalId } = useParams();
  const id = Number(goalId);
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "preview" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const view = await ipc.goalView(id);
      setState({ kind: "ready", view });
    } catch (err) {
      const message =
        err instanceof NotInTauriError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: "error", message });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const goalName = state.kind === "ready" ? state.view.goal.name : "Goal";

  return (
    <div className="min-h-full p-6">
    <div className="animate-fade-up mx-auto max-w-6xl">
      <div className="flex items-center gap-3">
        <BackButton to="/library" />
        <Breadcrumb
          items={[
            { label: "Library", to: "/library" },
            { label: goalName },
          ]}
        />
      </div>

      <header className="mb-6 mt-3 flex items-center gap-3">
        {state.kind === "ready" && (
          <span aria-hidden="true" className="text-2xl">
            {state.view.goal.icon}
          </span>
        )}
        <div>
          <h1 className="text-2xl font-bold text-content-primary">{goalName}</h1>
          <p className="mt-1 text-sm text-content-muted">Subjects in this goal.</p>
        </div>
      </header>

      {state.kind === "loading" && (
        <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass h-32 animate-pulse rounded-card p-card" aria-hidden="true" />
          ))}
        </div>
      )}

      {state.kind === "ready" && state.view.subjects.length > 0 && (
        <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3">
          {state.view.subjects.map((s) => (
            <SubjectCard key={s.id} subject={s} />
          ))}
        </div>
      )}

      {state.kind === "ready" && state.view.subjects.length === 0 && (
        <div className="glass flex min-h-52 flex-col items-center justify-center gap-3 rounded-card p-card text-center">
          <div className="text-4xl" aria-hidden="true">
            📚
          </div>
          <div>
            <p className="font-medium text-content-primary">No subjects yet</p>
            <p className="mt-1 text-sm text-content-muted">
              Import a folder into this goal from the Library to add subjects.
            </p>
          </div>
          <Link
            to="/library"
            className="mt-1 rounded-btn border border-white/10 px-4 py-2 text-sm text-content-secondary transition-colors hover:bg-white/[0.05]"
          >
            ← Back to Library
          </Link>
        </div>
      )}

      {state.kind === "preview" && (
        <div className="glass grid min-h-40 place-items-center rounded-card p-card text-center text-sm text-content-muted">
          Preview mode — open inside the desktop app to browse your library.
        </div>
      )}

      {state.kind === "error" && (
        <div className="rounded-card border border-orange/30 bg-orange/[0.06] p-card text-sm text-orange">
          Could not load this goal: {state.message}
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
