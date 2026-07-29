/**
 * Chapter page (Section 8, Page 5): a chapter's materials list — the leaf of the
 * Library hierarchy.
 *
 * One `ipc.chapterView(id)` round-trip returns the chapter header + full ancestry (for
 * the breadcrumb) and its materials. Materials render as inert rows: opening one is the
 * Video Player milestone, so nothing here fakes navigation (see `MaterialRow`).
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Breadcrumb from "../components/layout/Breadcrumb";
import BackButton from "../components/layout/BackButton";
import MaterialRow from "../components/library/MaterialRow";
import { ipc, isTauri, NotInTauriError } from "../lib/ipc";
import type { ChapterView } from "../lib/types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; view: ChapterView }
  | { kind: "preview" }
  | { kind: "error"; message: string };

export default function ChapterPage() {
  const { chapterId } = useParams();
  const id = Number(chapterId);
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "preview" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const view = await ipc.chapterView(id);
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

  const chapterName = state.kind === "ready" ? state.view.chapter.name : "Chapter";
  const crumbs =
    state.kind === "ready"
      ? [
          { label: "Library", to: "/library" },
          {
            label: state.view.chapter.goal_name,
            to: `/library/goal/${state.view.chapter.goal_id}`,
          },
          {
            label: state.view.chapter.subject_name,
            to: `/library/subject/${state.view.chapter.subject_id}`,
          },
          { label: chapterName },
        ]
      : [{ label: "Library", to: "/library" }, { label: chapterName }];

  const count = state.kind === "ready" ? state.view.materials.length : 0;

  return (
    <div className="min-h-full p-6">
    <div className="animate-fade-up mx-auto max-w-6xl">
      <div className="flex items-center gap-3">
        <BackButton
          to={
            state.kind === "ready"
              ? `/library/subject/${state.view.chapter.subject_id}`
              : "/library"
          }
        />
        <Breadcrumb items={crumbs} />
      </div>

      <header className="mb-6 mt-3">
        <h1 className="text-2xl font-bold text-content-primary">{chapterName}</h1>
        {state.kind === "ready" && (
          <p className="mt-1 text-sm text-content-muted">
            {count} file{count === 1 ? "" : "s"} · click-to-play arrives with the player.
          </p>
        )}
      </header>

      {state.kind === "loading" && (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass h-16 animate-pulse rounded-card p-card" aria-hidden="true" />
          ))}
        </div>
      )}

      {state.kind === "ready" && count > 0 && (
        <div className="flex flex-col gap-2.5">
          {state.view.materials.map((m) => (
            <MaterialRow key={m.id} material={m} />
          ))}
        </div>
      )}

      {state.kind === "ready" && count === 0 && (
        <div className="glass flex min-h-52 flex-col items-center justify-center gap-3 rounded-card p-card text-center">
          <div className="text-4xl" aria-hidden="true">
            🗂️
          </div>
          <div>
            <p className="font-medium text-content-primary">No files in this chapter</p>
            <p className="mt-1 text-sm text-content-muted">
              Nothing was found here during the scan.
            </p>
          </div>
          <Link
            to={
              state.kind === "ready"
                ? `/library/subject/${state.view.chapter.subject_id}`
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
          Could not load this chapter: {state.message}
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
