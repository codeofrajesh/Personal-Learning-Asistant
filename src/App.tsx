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
import { HashRouter, Navigate, Routes, Route, useParams } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import { getPluginRoutes } from "./lib/plugins/routes";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const CoursesPage = lazy(() => import("./pages/CoursesPage"));
const ExploreCategoryPage = lazy(() => import("./pages/ExploreCategoryPage"));
const PlanningHub = lazy(() => import("./pages/PlanningHub"));
const PlayerPage = lazy(() => import("./pages/PlayerPage"));
const Settings = lazy(() => import("./pages/Settings"));
const NotFound = lazy(() => import("./pages/NotFound"));
const PluginsPage = lazy(() => import("./pages/PluginsPage"));

/** Lightweight route fallback while a page chunk loads. */
function PageFallback() {
  return (
    <div className="grid min-h-[40vh] place-items-center text-sm text-content-muted">
      Loading…
    </div>
  );
}

/**
 * Redirect a legacy `/library/:kind/:id` route into the unified tree browser. The v6
 * shim returns node ids in the old `goal_id`/`subject_id`/`chapter_id` fields, so any id
 * that used to name a goal/subject/chapter now names a node — the same value drills the
 * browser to the right place. `replace` so Back skips the dead URL.
 */
function NodeRedirect({ param }: { param: string }) {
  const params = useParams();
  const id = params[param];
  return <Navigate to={id != null ? `/courses/${id}` : "/courses"} replace />;
}

/**
 * Build a lazy route for a plugin path that isn't pre-registered in App.tsx.
 * Plugin manifests declare their own lazy import; this wraps it with Suspense.
 */
function PluginRoute({ path, importFn }: { path: string; importFn: () => Promise<{ default: React.ComponentType }> }) {
  const LazyComponent = lazy(importFn);
  return (
    <Route
      path={path}
      element={
        <Suspense fallback={<PageFallback />}>
          <LazyComponent />
        </Suspense>
      }
    />
  );
}

export default function App() {
  const pluginRoutes = getPluginRoutes();

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
            path="courses"
            element={
              <Suspense fallback={<PageFallback />}>
                <CoursesPage />
              </Suspense>
            }
          />
          <Route
            path="courses/:nodeId"
            element={
              <Suspense fallback={<PageFallback />}>
                <CoursesPage />
              </Suspense>
            }
          />
          {/* Courses hub "Explore ›" drill-downs — full category lists. */}
          <Route
            path="explore/:category"
            element={
              <Suspense fallback={<PageFallback />}>
                <ExploreCategoryPage />
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
          {/* Legacy Library routes → unified tree browser (ids are node ids under v6). */}
          <Route path="library" element={<Navigate to="/courses" replace />} />
          <Route path="library/goal/:goalId" element={<NodeRedirect param="goalId" />} />
          <Route path="library/subject/:subjectId" element={<NodeRedirect param="subjectId" />} />
          <Route path="library/chapter/:chapterId" element={<NodeRedirect param="chapterId" />} />
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
            path="plugins"
            element={
              <Suspense fallback={<PageFallback />}>
                <PluginsPage />
              </Suspense>
            }
          />
          {/* Plugin routes — code-split via their manifests. */}
          {pluginRoutes.map((r) => (
            <PluginRoute key={r.path} path={r.path} importFn={r.lazy} />
          ))}
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
