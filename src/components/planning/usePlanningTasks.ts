/**
 * usePlanningTasks — the single source of truth for task state on the Planning page,
 * shared by the Planner tab, the Calendar/Timeline, and the Table view so all three
 * stay in sync from one load + one set of optimistic mutations.
 *
 * All writes are optimistic (flip local state → persist via IPC → reload on error),
 * matching the established TasksWidget pattern. Completing a task also refreshes the
 * consistency summary (the backend re-snapshots "today" on completion).
 */

import { useCallback, useEffect, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { localDay } from "../../lib/scheduleClock";
import type { ConsistencySummary, DashboardData, Task } from "../../lib/types";

export interface NewTaskInput {
  title: string;
  priority: number;
  due_at: string | null;
  material_id: number | null;
  material_name: string | null;
  material_type: string | null;
  estimated_mins: number | null;
}

export interface PlanningTasks {
  tasks: Task[];
  consistency: ConsistencySummary | null;
  nextUp: DashboardData["next_up"];
  loaded: boolean;
  preview: boolean;
  reload: () => Promise<void>;
  addTask: (input: NewTaskInput) => Promise<void>;
  toggleDone: (task: Task) => Promise<void>;
  removeTask: (task: Task) => Promise<void>;
  applyEdit: (task: Task, patch: Partial<Task>) => Promise<void>;
}

export function usePlanningTasks(): PlanningTasks {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [consistency, setConsistency] = useState<ConsistencySummary | null>(null);
  const [nextUp, setNextUp] = useState<DashboardData["next_up"]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(false);

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setPreview(true);
      setLoaded(true);
      return;
    }
    try {
      const [t, c, dash] = await Promise.all([
        ipc.listTasks(),
        ipc.consistencySummary(localDay()),
        ipc.dashboardData(),
      ]);
      setTasks(t);
      setConsistency(c);
      setNextUp(dash.next_up);
    } catch {
      /* keep prior state */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addTask = useCallback(async (input: NewTaskInput) => {
    if (!isTauri() || !input.title.trim()) return;
    const tempId = -Date.now();
    const optimistic: Task = {
      id: tempId,
      title: input.title.trim(),
      done: false,
      priority: input.priority,
      due_at: input.due_at,
      material_id: input.material_id,
      material_name: input.material_name,
      material_type: input.material_type,
      sort_order: 0,
      estimated_mins: input.estimated_mins,
      completed_at: null,
      created_at: new Date().toISOString(),
    };
    setTasks((cur) => [optimistic, ...cur]);
    try {
      const realId = await ipc.createTask(
        optimistic.title,
        input.priority,
        input.due_at,
        input.material_id,
        input.estimated_mins,
      );
      setTasks((cur) => cur.map((t) => (t.id === tempId ? { ...t, id: realId } : t)));
    } catch {
      setTasks((cur) => cur.filter((t) => t.id !== tempId));
    }
  }, []);

  const toggleDone = useCallback(async (task: Task) => {
    const next = !task.done;
    setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, done: next } : t)));
    try {
      await ipc.setTaskDone(task.id, next);
      void ipc.consistencySummary(localDay()).then(setConsistency).catch(() => {});
    } catch {
      setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, done: !next } : t)));
    }
  }, []);

  const removeTask = useCallback(
    async (task: Task) => {
      setTasks((cur) => cur.filter((t) => t.id !== task.id));
      try {
        await ipc.deleteTask(task.id);
      } catch {
        void reload();
      }
    },
    [reload],
  );

  const applyEdit = useCallback(
    async (task: Task, patch: Partial<Task>) => {
      const merged = { ...task, ...patch };
      setTasks((cur) => cur.map((t) => (t.id === task.id ? merged : t)));
      try {
        await ipc.updateTask(
          task.id,
          merged.title,
          merged.priority,
          merged.due_at,
          merged.material_id,
          merged.estimated_mins,
        );
      } catch {
        void reload();
      }
    },
    [reload],
  );

  return {
    tasks,
    consistency,
    nextUp,
    loaded,
    preview,
    reload,
    addTask,
    toggleDone,
    removeTask,
    applyEdit,
  };
}
