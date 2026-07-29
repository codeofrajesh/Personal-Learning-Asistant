/**
 * Subject page (Section 8, Page 4): a subject's chapters list.
 *
 * One `ipc.subjectView(id)` round-trip returns the subject header + parent goal (for
 * the breadcrumb) and its chapters with rolled-up counts. Same four-state pattern as
 * the other Library pages.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Breadcrumb from "../components/layout/Breadcrumb";
import BackButton from "../components/layout/BackButton";
import ChapterCard from "../components/library/ChapterCard";
import { ipc, isTauri, NotInTauriError } from "../lib/ipc";
import type { SubjectView } from "../lib/types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; view: SubjectView }
  | { kind: "preview" }
  | { kind: "error"; message: string };

export default function SubjectPage() {
  const { subjectId } = useParams();
  const id = Number(subjectId);
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "preview" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const view = await ipc.subjectView(id);
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

  const subjectName = state.kind === "ready" ? state.view.subject.name : "Subject";
  const crumbs =
    state.kind === "ready"
      ? [
          { label: "Library", to: "/library" },
          {
            label: state.view.subject.goal_name,
            to: `/library/goal/${state.view.subject.goal_id}`,
          },
          { label: subjectName },
        ]
      : [{ label: "Library", to: "/library" }, { label: subjectName }];

  return (
    <div className="min-h-full p-6">
    <div className="animate-fade-up mx-auto max-w-6xl">
      <div className="flex items-center gap-3">
        <BackButton
          to={
            state.kind === "ready"
              ? `/library/goal/${state.view.subject.goal_id}`
              : "/library"
          }
        />
        <Breadcrumb items={crumbs} />
      </div>

      <header className="mb-6 mt-3">
        <h1 className="text-2xl font-bold text-content-primary">{subjectName}</h1>
        <p className="mt-1 text-sm text-content-muted">Chapters in this subject.</p>
      </header>

      {state.kind === "loading" && (
        <div className="flex flex-col gap-gutter">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="glass h-20 animate-pulse rounded-card p-card" aria-hidden="true" />
          ))}
        </div>
      )}

      {state.kind === "ready" && state.view.chapters.length > 0 && (
        <div className="flex flex-col gap-gutter">
          {state.view.chapters.map((c) => (
            <ChapterCard key={c.id} chapter={c} />
          ))}
        </div>
      )}

      {state.kind === "ready" && state.view.chapters.length === 0 && (
        <div className="glass flex min-h-52 flex-col items-center justify-center gap-3 rounded-card p-card text-center">
          <div className="text-4xl" aria-hidden="true">
            📂
          </div>
          <div>
            <p className="font-medium text-content-primary">No chapters yet</p>
            <p className="mt-1 text-sm text-content-muted">
              This subject has no chapters. Re-import its folder to populate it.
            </p>
          </div>
          <Link
            to={
              state.kind === "ready"
                ? `/library/goal/${state.view.subject.goal_id}`
                : "/library"
            }
            className="mt-1 rounded-btn border border-white/10 px-4 py-2 text-sm text-content-secondary transition-colors hover:bg-white/[0.05]"
          >
            ← Back
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
          Could not load this subject: {state.message}
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
