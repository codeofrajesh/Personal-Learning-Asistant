/**
 * CoursesPage — the premium LMS "My Courses" surface (image fav.png), replacing the
 * generic Library tree as the content hub (Courses re-architecture, Step 3).
 *
 * Layout:
 *   1. Goal selector pills — "All" + one per goal. Active pill = lime (brand-correct
 *      equivalent of the reference's light-gray active pill in a dark theme). Defaults
 *      to the recently active goal (ipc.recentGoalId), else "All".
 *   2. Continue Learning — a massive 2-column featured card: the most recently watched
 *      course's cover thumbnail, its name + the up-next lesson, a circular progress
 *      ring, and "To the course" + "Resume lesson" actions. Hidden when nothing's been
 *      watched yet (honest empty — no fabricated in-progress state).
 *   3. All Courses — a responsive grid of CourseCards (thumbnail covers, title, chapter/
 *      lesson tally, completion bar, "View Details"), filtered by the selected pill.
 *      "All" flattens every goal's subjects.
 *
 * Data: one `listLibrary` (goals) + `recentGoalId` (default pill) + `dashboardData`
 * (continue-learning item) on boot; `goalView` per goal when the pill changes (parallel
 * for "All"). The SubjectSummary now carries a `thumbnail_path` cover (Step 2).
 *
 * Motion (gsap-core / gsap-react principles, matched to the Dashboard's pattern: no
 * @gsap/react dep, `gsap.context()` in useLayoutEffect + ctx.revert(), reduced-motion
 * gated): pills + continue card animate once on boot; course cards re-stagger on each
 * pill switch. Motion is motivated (entrance hierarchy + confirming a pill switch).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { gsap } from "gsap";
import { Play, Plus } from "lucide-react";
import Breadcrumb from "../components/layout/Breadcrumb";
import CourseCard from "../components/courses/CourseCard";
import ProgressRing from "../components/courses/ProgressRing";
import CoverArt from "../components/ui/CoverArt";
import { useMaterialManager } from "../lib/materialManagerStore";
import { ipc, isTauri, NotInTauriError, onLibraryChanged } from "../lib/ipc";
import type { GoalSummary, RecentMaterial, SubjectSummary } from "../lib/types";

type Boot =
  | { kind: "loading" }
  | { kind: "ready"; goals: GoalSummary[]; recent: RecentMaterial | null }
  | { kind: "preview" }
  | { kind: "error"; message: string };

/** A grid item: a subject + the goal name to caption it (the reference's "BY …" line). */
type GridItem = { subject: SubjectSummary; goalName: string };

const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40 disabled:pointer-events-none disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-2 rounded-btn border border-glass-border px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40";

export default function CoursesPage() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const [selectedGoalId, setSelectedGoalId] = useState<number | null>(null);
  const [grid, setGrid] = useState<GridItem[] | null>(null);
  const openAddFolder = useMaterialManager((s) => s.openAddFolder);
  const importNonce = useMaterialManager((s) => s.importNonce);
  const rootRef = useRef<HTMLDivElement>(null);

  const errMsg = (err: unknown) =>
    err instanceof NotInTauriError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);

  // ── boot: goals + default pill + continue-learning item ──
  const loadBoot = useCallback(async () => {
    if (!isTauri()) {
      setBoot({ kind: "preview" });
      return;
    }
    setBoot({ kind: "loading" });
    try {
      const [goals, recentGoalId, dash] = await Promise.all([
        ipc.listLibrary(),
        ipc.recentGoalId(),
        ipc.dashboardData(),
      ]);
      const recent = dash.continue_learning[0] ?? null;
      // Default the pill to the recently active goal (if it still exists), else "All".
      const defaultGoal =
        recentGoalId != null && goals.some((g) => g.id === recentGoalId)
          ? recentGoalId
          : null;
      setBoot({ kind: "ready", goals, recent });
      setSelectedGoalId(defaultGoal);
    } catch (err) {
      setBoot({ kind: "error", message: errMsg(err) });
    }
  }, []);

  useEffect(() => {
    void loadBoot();
  }, [loadBoot]);

  // ── grid: subjects for the selected pill ("All" → flatten every goal) ──
  const goals = boot.kind === "ready" ? boot.goals : [];

  const loadGrid = useCallback(
    async (goalId: number | null) => {
      if (!isTauri() || goals.length === 0) {
        setGrid([]);
        return;
      }
      setGrid(null); // null = loading skeleton
      try {
        if (goalId == null) {
          const views = await Promise.all(goals.map((g) => ipc.goalView(g.id)));
          setGrid(
            views.flatMap((v) =>
              v.subjects.map((s) => ({ subject: s, goalName: v.goal.name })),
            ),
          );
        } else {
          const g = goals.find((x) => x.id === goalId);
          const view = await ipc.goalView(goalId);
          setGrid(
            view.subjects.map((s) => ({
              subject: s,
              goalName: g?.name ?? "",
            })),
          );
        }
      } catch {
        setGrid([]);
      }
    },
    [goals],
  );

  useEffect(() => {
    if (boot.kind === "ready") void loadGrid(selectedGoalId);
  }, [boot.kind, selectedGoalId, loadGrid]);

  // Live-refresh when a watched folder changes (new imports / rescans).
  useEffect(() => {
    let unlisten: () => void = () => {};
    void onLibraryChanged(() => {
      void loadBoot();
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten();
  }, [loadBoot]);

  // Refetch after a successful import from the global Add-Folder modal.
  useEffect(() => {
    if (importNonce > 0) void loadBoot();
  }, [importNonce, loadBoot]);

  // ── GSAP entrances (Dashboard pattern: gsap.context + ctx.revert, reduced-motion) ──
  const prefersReduced = useCallback(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Boot entrance: pills + continue card, once.
  useLayoutEffect(() => {
    if (boot.kind !== "ready" || prefersReduced()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out", duration: 0.5 } });
      tl.from(".course-pill", { y: 12, opacity: 0, stagger: 0.05 });
      if (document.querySelector(".continue-card")) {
        tl.from(".continue-card", { y: 24, opacity: 0 }, "-=0.2");
      }
    }, rootRef);
    return () => ctx.revert();
  }, [boot.kind, prefersReduced]);

  // Grid entrance: re-stagger the cards each time the pill switches.
  useLayoutEffect(() => {
    if (!grid || grid.length === 0 || prefersReduced()) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        ".course-card",
        { y: 24, opacity: 0 },
        { y: 0, opacity: 1, ease: "power3.out", duration: 0.45, stagger: 0.05 },
      );
    }, rootRef);
    return () => ctx.revert();
  }, [grid, prefersReduced]);

  // ── render ──
  const recent = boot.kind === "ready" ? boot.recent : null;
  const recentPct = recent ? Math.max(0, Math.min(100, recent.progress_pct)) : 0;

  return (
    <div className="relative min-h-full p-6">
      {/* Ambient lighting lives on the unified app canvas (AppShell). */}

      <div ref={rootRef} className="mx-auto max-w-7xl">
        <Breadcrumb items={[{ label: "Courses" }]} />

        <header className="mb-6 mt-3 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-content-primary">My Courses</h1>
            <p className="mt-1 text-sm text-content-muted">
              Pick up where you left off, or start something new.
            </p>
          </div>
          {boot.kind !== "preview" && (
            <button
              type="button"
              onClick={openAddFolder}
              className={btnPrimary}
            >
              <Plus size={16} strokeWidth={2.5} aria-hidden />
              Add Folder
            </button>
          )}
        </header>

        {/* Goal selector pills */}
        {boot.kind === "ready" && (
          <div
            className="mb-8 flex flex-wrap items-center gap-2"
            role="tablist"
            aria-label="Filter courses by goal"
          >
            <GoalPill
              active={selectedGoalId === null}
              onClick={() => setSelectedGoalId(null)}
              label="All"
            />
            {goals.map((g) => (
              <GoalPill
                key={g.id}
                active={selectedGoalId === g.id}
                onClick={() => setSelectedGoalId(g.id)}
                label={g.name}
                icon={g.icon}
              />
            ))}
          </div>
        )}

        {/* Continue Learning featured card */}
        {boot.kind === "ready" && recent && (
          <section className="continue-card mb-10 overflow-hidden rounded-panel border border-white/[0.05] bg-white/[0.02] shadow-2xl backdrop-blur-md">
            <div className="grid md:grid-cols-2">
              {/* Cover — extracted thumbnail, else a deterministic brand gradient. */}
              <div className="relative aspect-video w-full overflow-hidden md:aspect-auto md:min-h-[18rem]">
                <CoverArt
                  thumbnailPath={recent.thumbnail_path}
                  seed={recent.subject_id}
                  glyph={TYPE_GLYPH[recent.file_type] ?? "📚"}
                  className="h-full w-full"
                />
                <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-ink-900/70 via-transparent to-transparent" />
              </div>

              {/* Body */}
              <div className="flex flex-col justify-between gap-6 p-6 lg:p-8">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lime">
                    Continue Learning
                  </p>
                  <h2 className="font-display mt-2 text-2xl font-bold text-content-primary lg:text-3xl">
                    {recent.subject_name}
                  </h2>
                  <p className="mt-2 text-sm text-content-muted">
                    Up next · <span className="text-content-secondary">{recent.file_name}</span>
                  </p>
                  <p className="mt-1 text-xs text-content-faint">
                    {recent.goal_name} · {recent.chapter_name}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <ProgressRing
                    pct={recentPct}
                    size={92}
                    strokeWidth={9}
                    ariaLabel={`${recent.subject_name} progress`}
                  />
                  <div className="hidden sm:block">
                    <p className="text-sm font-semibold text-content-primary">
                      {recentPct}% complete
                    </p>
                    <p className="text-xs text-content-muted">Keep the streak going.</p>
                  </div>
                </div>

                  <div className="flex flex-col gap-2">
                    <Link to={`/courses/${recent.subject_id}`} className={btnPrimary}>
                      To the course
                    </Link>
                    <Link
                      to={`/library/material/${recent.id}`}
                      state={{ source: "courses" }}
                      className={btnGhost}
                    >
                      <Play size={14} strokeWidth={2.5} aria-hidden />
                      Resume lesson
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* All Courses grid */}
        {boot.kind === "ready" && (
          <section>
            <h2 className="font-display mb-4 text-sm font-semibold uppercase tracking-wide text-content-secondary">
              All Courses
              {grid && (
                <span className="ml-2 text-xs font-normal text-content-faint">
                  {grid.length}
                </span>
              )}
            </h2>

            {grid === null && (
              <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-64 animate-pulse rounded-card border border-glass-border bg-ink-800"
                    aria-hidden
                  />
                ))}
              </div>
            )}

            {grid !== null && grid.length > 0 && (
              <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {grid.map(({ subject, goalName }) => (
                  <CourseCard
                    key={subject.id}
                    subject={subject}
                    goalName={selectedGoalId == null ? goalName : undefined}
                  />
                ))}
              </div>
            )}

            {grid !== null && grid.length === 0 && (
              <div className="glass flex min-h-52 flex-col items-center justify-center gap-3 rounded-card p-card text-center">
                <div className="text-4xl" aria-hidden>
                  📚
                </div>
                <div>
                  <p className="font-medium text-content-primary">No courses here yet</p>
                  <p className="mt-1 text-sm text-content-muted">
                    {goals.length === 0
                      ? "Add a folder of videos, PDFs, or notes to build your first course."
                      : "This goal has no subjects. Add a folder filed under it."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openAddFolder}
                  className={btnPrimary}
                >
                  <Plus size={16} strokeWidth={2.5} aria-hidden />
                  Add a folder
                </button>
              </div>
            )}
          </section>
        )}

        {boot.kind === "loading" && (
          <div className="space-y-8">
            <div className="flex gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-9 w-24 animate-pulse rounded-full bg-white/[0.05]"
                  aria-hidden
                />
              ))}
            </div>
            <div className="h-64 animate-pulse rounded-panel border border-glass-border bg-ink-800" aria-hidden />
            <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-64 animate-pulse rounded-card border border-glass-border bg-ink-800"
                  aria-hidden
                />
              ))}
            </div>
          </div>
        )}

        {boot.kind === "preview" && (
          <div className="glass grid min-h-40 place-items-center rounded-card p-card text-center text-sm text-content-muted">
            Preview mode — open inside the desktop app to see your courses.
          </div>
        )}

        {boot.kind === "error" && (
          <div className="rounded-card border border-orange/30 bg-orange/[0.06] p-card text-sm text-orange">
            Could not load your courses: {boot.message}
            <button
              type="button"
              onClick={() => void loadBoot()}
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

/** A goal-filter pill (the reference's ALL / FPM / ABAP row, in the dark + lime language). */
function GoalPill({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "course-pill inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40 " +
        (active
          ? "bg-lime text-ink-900 shadow-glow-lime"
          : "bg-white/[0.04] text-content-secondary hover:bg-white/[0.08] hover:text-content-primary")
      }
    >
      {icon && <span aria-hidden>{icon}</span>}
      {label}
    </button>
  );
}
