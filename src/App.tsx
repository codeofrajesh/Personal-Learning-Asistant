/**
 * App root: router + layout composition.
 *
 * Uses `HashRouter` — Tauri serves the built app from a static file origin, so hash
 * routing avoids deep-link 404s without any server rewrite rules.
 *
 * Pages are code-split with `React.lazy` + `Suspense` (Section 15 React perf rule:
 * Dashboard / Library / Player as separate chunks). The AppShell layout is eager so
 * the sidebar/topbar never flash. `prefers-reduced-motion` is respected globally in
 * index.css.
 */

import { lazy, Suspense } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import AppShell from "./components/layout/AppShell";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Library = lazy(() => import("./pages/Library"));
const CoursesPage = lazy(() => import("./pages/CoursesPage"));
const CourseDetailPage = lazy(() => import("./pages/CourseDetailPage"));
const PlanningHub = lazy(() => import("./pages/PlanningHub"));
const GoalPage = lazy(() => import("./pages/GoalPage"));
const SubjectPage = lazy(() => import("./pages/SubjectPage"));
const ChapterPage = lazy(() => import("./pages/ChapterPage"));
const PlayerPage = lazy(() => import("./pages/PlayerPage"));
const Settings = lazy(() => import("./pages/Settings"));
const NotFound = lazy(() => import("./pages/NotFound"));

/** Lightweight route fallback while a page chunk loads. */
function PageFallback() {
  return (
    <div className="grid min-h-[40vh] place-items-center text-sm text-content-muted">
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            index
            element={
              <Suspense fallback={<PageFallback />}>
                <Dashboard />
              </Suspense>
            }
          />
          <Route
            path="library"
            element={
              <Suspense fallback={<PageFallback />}>
                <Library />
              </Suspense>
            }
          />
          <Route
            path="courses"
            element={
              <Suspense fallback={<PageFallback />}>
                <CoursesPage />
              </Suspense>
            }
          />
          <Route
            path="planning"
            element={
              <Suspense fallback={<PageFallback />}>
                <PlanningHub />
              </Suspense>
            }
          />
          <Route
            path="courses/:subjectId"
            element={
              <Suspense fallback={<PageFallback />}>
                <CourseDetailPage />
              </Suspense>
            }
          />
          <Route
            path="library/goal/:goalId"
            element={
              <Suspense fallback={<PageFallback />}>
                <GoalPage />
              </Suspense>
            }
          />
          <Route
            path="library/subject/:subjectId"
            element={
              <Suspense fallback={<PageFallback />}>
                <SubjectPage />
              </Suspense>
            }
          />
          <Route
            path="library/chapter/:chapterId"
            element={
              <Suspense fallback={<PageFallback />}>
                <ChapterPage />
              </Suspense>
            }
          />
          <Route
            path="library/material/:materialId"
            element={
              <Suspense fallback={<PageFallback />}>
                <PlayerPage />
              </Suspense>
            }
          />
          <Route
            path="settings"
            element={
              <Suspense fallback={<PageFallback />}>
                <Settings />
              </Suspense>
            }
          />
          <Route
            path="*"
            element={
              <Suspense fallback={<PageFallback />}>
                <NotFound />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </HashRouter>
  );
}
