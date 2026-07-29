/**
 * materialManagerStore — the single source of truth for the "Add / Scan / Rescan
 * folder" surface. Previously the AddFolderWizard was mounted three times (Library,
 * Courses, Settings), each page holding its own open-state + refetch. This store
 * centralizes that: one global modal is mounted once (in AppShell), and any page opens
 * it via `openAddFolder()`.
 *
 * The store also broadcasts the last successful import so every page can refetch
 * without prop-drilling an `onImported` callback. Pages subscribe to `importNonce`
 * (a monotonically increasing counter bumped on each import) in an effect and refetch
 * when it changes — complementing the existing `library://changed` watcher event.
 */

import { create } from "zustand";
import type { ImportResult } from "./types";

interface MaterialManagerState {
  /** Whether the global Add-Folder modal is open. */
  addFolderOpen: boolean;
  /** Bumped after every successful import so pages can refetch. */
  importNonce: number;
  /** The most recent successful import result (for any interested surface). */
  lastImport: ImportResult | null;

  openAddFolder: () => void;
  closeAddFolder: () => void;
  /** Called by the modal on a successful import. */
  notifyImported: (result: ImportResult) => void;
}

export const useMaterialManager = create<MaterialManagerState>((set) => ({
  addFolderOpen: false,
  importNonce: 0,
  lastImport: null,

  openAddFolder: () => set({ addFolderOpen: true }),
  closeAddFolder: () => set({ addFolderOpen: false }),
  notifyImported: (result) =>
    set((s) => ({ lastImport: result, importNonce: s.importNonce + 1 })),
}));
