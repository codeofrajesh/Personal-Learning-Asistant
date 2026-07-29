/**
 * CourseDetailPage — the premium LMS course detail surface (image 3.png), Step 4.
 *
 * Layout:
 *   - Header: course title + goal caption + a circular progress ring (completed/total)
 *     + a chapter/lesson/completed tally, on a glassmorphism panel. GSAP fades it
 *     in on load.
 *   - Lesson list: every material across the subject's chapters, flattened and
 *     sequence-ordered (Step 2 `course_view`), grouped under STICKY chapter headers,
 *     stretched full-width (no max-w cap) like image 3.png. Each row is transparent with
 *     a faint bottom separator + a 3D hover glow (no neon borders):
 *       [3D numbered circle 01] · [title + muted metadata] · [bookmark] · [status]
 *     where status is a subtle-green ✔ "Done" when completed, or muted-orange
 *     "Start ›" when not. Bookmark is faint gray by default, solid lime when active.
 *     Clicking a row routes to the Video Player.
 *
 * 3D polish (ui-ux-pro-max — Tailwind-only, no external UI libs): ambient lime blur
 * blobs behind the page, a 3D inset-glass course header, 3D tactile numbered circles
 * (gradient + inset highlight), and rows that lift on hover with an inset top sheen.
 *
 * Styling discipline (ui-ux-pro-max / frontend-design / design-taste-frontend / ui-styling):
 *   - Dark glassmorphism: bg-white/[0.02] surfaces, border-white/[0.05], shadow-2xl,
 *     backdrop-blur-md. No default tailwind gray; the page uses a premium dark gradient
 *     from-[#121212] to-[#050505]. No neon/lime borders on list rows.
 *   - White-with-alpha for subtle separators/circles (white/[0.03..0.06]), lime reserved
 *     for the single completion accent, orange-400/80 for the "Start" affordance.
 *   - Generous py-4 rows, sleek typography (content-primary titles, content-muted meta).
 *
 * Data: one `ipc.courseView(subjectId)` round-trip. Bookmark toggles are optimistic.
 *
 * Motion: gsap.context() in useLayoutEffect + ctx.revert() (Dashboard pattern, no
 * @gsap/react dep), gated on prefers-reduced-motion. The progress ring draws via its
 * own CSS; GSAP handles the header + lesson-row stagger.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { gsap } from "gsap";
import {
  Bookmark,
  Check,
  ChevronRight,
  FileVideo,
  FileText,
  FileAudio,
  FileImage,
  File as FileLucide,
} from "lucide-react";
import Breadcrumb from "../components/layout/Breadcrumb";
import BackButton from "../components/layout/BackButton";
import ProgressRing from "../components/courses/ProgressRing";
import { ipc, isTauri, NotInTauriError } from "../lib/ipc";
import { withSource } from "../lib/navigation";
import { cn } from "../lib/utils";
import type { CourseLesson, CourseView } from "../lib/types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; view: CourseView; lessons: CourseLesson[] }
  | { kind: "preview" }
  | { kind: "error"; message: string };

/** File-type → a sleek lucide icon (replaces the earlier emoji glyphs). */
const FILE_ICON: Record<string, typeof FileLucide> = {
  video: FileVideo,
  pdf: FileText,
  note: FileText,
  image: FileImage,
  audio: FileAudio,
};

const errMsg = (err: unknown) =>
  err instanceof NotInTauriError
    ? err.message
    : err instanceof Error
      ? err.message
      : String(err);

export default function CourseDetailPage() {
  const { subjectId } = useParams();
  const id = Number(subjectId);
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "preview" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const view = await ipc.courseView(id);
      setState({ kind: "ready", view, lessons: view.lessons });
    } catch (err) {
      setState({ kind: "error", message: errMsg(err) });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Optimistic bookmark toggle: flip the local flag, fire the IPC write, revert on error.
  const toggleBookmark = useCallback(
    async (materialId: number, currentlyBookmarked: boolean) => {
      setState((cur) => {
        if (cur.kind !== "ready") return cur;
        return {
          ...cur,
          lessons: cur.lessons.map((l) =>
            l.id === materialId
              ? { ...l, is_bookmarked: !currentlyBookmarked }
              : l,
          ),
        };
      });
      try {
        await ipc.setBookmark(materialId, !currentlyBookmarked);
      } catch {
        setState((cur) => {
          if (cur.kind !== "ready") return cur;
          return {
            ...cur,
            lessons: cur.lessons.map((l) =>
              l.id === materialId
                ? { ...l, is_bookmarked: currentlyBookmarked }
                : l,
            ),
          };
        });
      }
    },
    [],
  );

  // GSAP entrance: header + chapter headers, staggered. Reduced-motion safe.
  // NOTE: the lesson rows are intentionally NOT animated by GSAP — they carry
  // `transition-all duration-300` for their 3D hover glow, and a `from(opacity:0)`
  // entrance fights that CSS transition and can strand rows at opacity:0 if the
  // timeline is interrupted. Rows render at their natural opacity and keep their
  // hover motion via CSS alone.
  useLayoutEffect(() => {
    if (state.kind !== "ready") return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out", duration: 0.5 } });
      tl.from(".course-header", { y: 24, opacity: 0 }).from(
        ".chapter-header",
        { y: 16, opacity: 0, stagger: 0.08 },
        "-=0.2",
      );
    }, rootRef);
    return () => ctx.revert();
  }, [state.kind]);

  // ── render ──
  const subjectName =
    state.kind === "ready" ? state.view.subject.name : "Course";
  const crumbs =
    state.kind === "ready"
      ? [
          { label: "Courses", to: "/courses" },
          { label: state.view.subject.goal_name },
          { label: subjectName },
        ]
      : [{ label: "Courses", to: "/courses" }, { label: subjectName }];

  const pct =
    state.kind === "ready" && state.view.material_count > 0
      ? Math.round(
          (state.view.completed_count / state.view.material_count) * 100,
        )
      : 0;

  return (
    <div className="relative min-h-full p-6">
      {/* Ambient lighting lives on the unified app canvas (AppShell). */}

      <div ref={rootRef} className="w-full max-w-none px-10">
        <div className="flex items-center gap-3">
          <BackButton to="/courses" label="All courses" />
          <Breadcrumb items={crumbs} />
        </div>

        {/* Header: title + progress ring (glassmorphism) */}
        {state.kind === "ready" && (
          <header className="course-header mt-4 mb-8 flex items-center justify-between gap-6 rounded-panel border border-white/[0.08] bg-gradient-to-br from-white/[0.04] to-transparent py-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-md px-6 lg:px-8">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-content-muted">
                in {state.view.subject.goal_name}
              </p>
              <h1 className="font-display mt-1 text-2xl font-bold text-content-primary lg:text-3xl">
                {subjectName}
              </h1>
              <p className="mt-2 text-sm text-content-secondary">
                {state.view.chapters.length} chapter
                {state.view.chapters.length === 1 ? "" : "s"} ·{" "}
                {state.view.material_count} lesson
                {state.view.material_count === 1 ? "" : "s"} ·{" "}
                <span className="text-lime/80">
                  {state.view.completed_count} completed
                </span>
              </p>
            </div>
            <ProgressRing
              pct={pct}
              size={132}
              strokeWidth={11}
              label="complete"
              ariaLabel={`${subjectName} completion`}
            />
          </header>
        )}

        {/* Lesson list — grouped under sticky chapter headers */}
        {state.kind === "ready" && (
          <div className="flex flex-col gap-6">
            {state.view.chapters.map((chapter) => {
              const chapterLessons = state.lessons.filter(
                (l) => l.chapter_id === chapter.id,
              );
              if (chapterLessons.length === 0) return null;
              return (
                <section key={chapter.id} className="flex flex-col">
                  <div className="chapter-header sticky top-0 z-10 -mx-2 mb-1 flex items-baseline justify-between gap-3 border-b border-white/[0.06] bg-ink-900/90 px-2 py-2.5 backdrop-blur-md">
                    <h2 className="font-display truncate text-sm font-semibold text-content-primary">
                      {chapter.name}
                    </h2>
                    <span className="shrink-0 text-xs text-content-muted">
                      {chapter.completed_count}/{chapter.material_count} done
                    </span>
                  </div>

                  <ul className="flex flex-col">
                    {chapterLessons.map((lesson) => {
                      const globalIdx =
                        state.lessons.findIndex((l) => l.id === lesson.id) + 1;
                      const idxLabel = String(globalIdx).padStart(2, "0");
                      const missing = lesson.status === "missing";
                      return (
                        <li key={lesson.id} className="cv-row">
                          <LessonRow
                            lesson={lesson}
                            idxLabel={idxLabel}
                            missing={missing}
                            onOpen={() =>
                              navigate(
                                `/library/material/${lesson.id}`,
                                withSource("courses"),
                              )
                            }
                            onToggleBookmark={() =>
                              void toggleBookmark(lesson.id, lesson.is_bookmarked)
                            }
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        {/* Empty: course has no lessons at all */}
        {state.kind === "ready" && state.lessons.length === 0 && (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-card border border-white/[0.05] bg-white/[0.02] p-card text-center shadow-2xl backdrop-blur-md">
            <div className="text-4xl" aria-hidden>
              📂
            </div>
            <div>
              <p className="font-medium text-content-primary">No lessons yet</p>
              <p className="mt-1 text-sm text-content-muted">
                This course has no materials. Re-import its folder to populate it.
              </p>
            </div>
          </div>
        )}

        {state.kind === "loading" && (
          <div className="mt-4 space-y-3">
            <div className="h-28 animate-pulse rounded-panel border border-white/[0.05] bg-white/[0.02]" aria-hidden />
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-btn border border-white/[0.05] bg-white/[0.02]"
                aria-hidden
              />
            ))}
          </div>
        )}

        {state.kind === "preview" && (
          <div className="grid min-h-40 place-items-center rounded-card border border-white/[0.05] bg-white/[0.02] p-card text-center text-sm text-content-muted shadow-2xl backdrop-blur-md">
            Preview mode — open inside the desktop app to open a course.
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-card border border-orange-400/30 bg-orange-400/[0.06] p-card text-sm text-orange-400/90">
            Could not load this course: {state.message}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-3 rounded-btn border border-orange-400/40 px-2.5 py-1 text-xs text-orange-400/90 transition-colors hover:bg-orange-400/10"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One lesson row: 3D numbered circle · title + muted metadata · bookmark · status.
 * Transparent background, faint bottom separator + 3D hover glow, no neon.
 */
function LessonRow({
  lesson,
  idxLabel,
  missing,
  onOpen,
  onToggleBookmark,
}: {
  lesson: CourseLesson;
  idxLabel: string;
  missing: boolean;
  onOpen: () => void;
  onToggleBookmark: () => void;
}) {
  const done = lesson.is_completed;
  const dur = lesson.duration_secs;
  const durLabel = dur != null && dur > 0 ? formatShortDuration(dur) : null;
  const inLabel =
    lesson.progress_pct > 0 && !done ? `${lesson.progress_pct}% in` : null;
  const FileIcon = FILE_ICON[lesson.file_type] ?? FileLucide;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Play lesson: ${lesson.file_name}`}
      className={cn(
        "lesson-row group flex cursor-pointer items-center gap-4 bg-transparent px-3 py-4 outline-none border-b border-white/[0.04] transition-all duration-300 hover:bg-gradient-to-r hover:from-white/[0.06] hover:to-transparent hover:border-white/[0.05] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] focus-visible:ring-1 focus-visible:ring-white/30",
        missing && "opacity-60",
      )}
    >
      {/* Numbered circle — 3D tactile, identical for every row; cyan accent on hover */}
      <span
        aria-hidden
        className="w-9 h-9 rounded-full flex items-center justify-center bg-gradient-to-b from-white/[0.12] to-white/[0.02] border border-white/[0.15] shadow-[inset_0_1px_2px_rgba(255,255,255,0.2)] text-white/70 font-medium transition-all duration-300 group-hover:border-cyan-400/40 group-hover:text-cyan-400 group-hover:shadow-[inset_0_1px_3px_rgba(34,211,238,0.35)]"
      >
        {idxLabel}
      </span>

      {/* Title + muted metadata */}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm font-medium",
            missing ? "text-content-muted" : "text-content-primary",
          )}
        >
          {lesson.file_name}
          {missing && (
            <span className="ml-1.5 text-xs text-orange-400/80">· file missing</span>
          )}
        </p>
        <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-content-muted">
          <FileIcon
            size={12}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 text-content-muted"
          />
          {durLabel && <span>{durLabel}</span>}
          {durLabel && inLabel && (
            <span aria-hidden className="text-white/20">
              ·
            </span>
          )}
          {inLabel && (
            <span className="text-content-secondary">{inLabel}</span>
          )}
        </p>
      </div>

      {/* Bookmark — faint gray default, solid lime only when active */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleBookmark();
        }}
        aria-label={lesson.is_bookmarked ? "Remove bookmark" : "Bookmark lesson"}
        aria-pressed={lesson.is_bookmarked}
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-btn transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
          lesson.is_bookmarked
            ? "text-lime hover:bg-lime/10"
            : "text-white/30 hover:bg-white/[0.05] hover:text-white/50",
        )}
      >
        <Bookmark
          size={16}
          strokeWidth={2}
          fill={lesson.is_bookmarked ? "currentColor" : "none"}
          aria-hidden
        />
      </button>

      {/* Status: subtle-green ✔ Done, or muted-orange Start › */}
      {done ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-lime/70">
          <Check size={14} strokeWidth={3} aria-hidden />
          Done
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-cyan-400/90">
          Start
          <ChevronRight size={13} strokeWidth={2.5} aria-hidden />
        </span>
      )}
    </div>
  );
}

/** Seconds → `H:MM:SS` / `M:SS`. */
function formatShortDuration(secs: number): string {
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
