/**
 * NodePicker — the "Add into an existing folder" destination selector for the
 * Add-Folder modal (Section 11, Phase 4).
 *
 * With the v6 infinite-depth tree, a picked disk folder can nest under ANY existing
 * node, not just a Goal. This is a compact, drill-down tree browser over
 * `ipc.nodeChildren`: click a row to SELECT it as the destination; click its chevron
 * (when it has children) to drill INTO it. A breadcrumb tracks the drill path and lets
 * you climb back out. The currently-selected node id is lifted to the parent.
 *
 * Conventions (ui-ux-pro-max / web-design-guidelines): `aria-current` on the selected
 * row, real focus rings, ≥40px row targets, breadcrumb with `nav`/`aria-label`, and a
 * depth cue that dims once past the cap (matching FolderPreview's DEPTH_CAP).
 * Degrades to an explanatory note outside the Tauri shell.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { ipc, isTauri } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import { DEPTH_CAP } from "./FolderPreview";
import type { NodeCard } from "../../lib/types";

interface NodePickerProps {
  /** The node id chosen as the import destination (null = nothing picked yet). */
  selectedId: number | null;
  /** Raised with the picked node (so the parent can show its name + depth). */
  onSelect: (node: NodeCard) => void;
}

/** One rung of the drill path (root-first). `null` id = the top-level roots view. */
type Crumb = { id: number | null; name: string };

export default function NodePicker({ selectedId, onSelect }: NodePickerProps) {
  const inApp = isTauri();
  const [path, setPath] = useState<Crumb[]>([{ id: null, name: "All goals" }]);
  const [children, setChildren] = useState<NodeCard[] | null>(null);
  const [error, setError] = useState<string>("");

  const currentParent = path[path.length - 1];

  const load = useCallback(
    async (parentId: number | null) => {
      if (!inApp) return;
      setChildren(null);
      setError("");
      try {
        setChildren(await ipc.nodeChildren(parentId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setChildren([]);
      }
    },
    [inApp],
  );

  useEffect(() => {
    void load(currentParent.id);
  }, [load, currentParent.id]);

  const drillInto = (node: NodeCard) => {
    setPath((p) => [...p, { id: node.id, name: node.name }]);
  };
  const jumpTo = (index: number) => {
    setPath((p) => p.slice(0, index + 1));
  };

  if (!inApp) {
    return (
      <div className="rounded-card border border-glass-border bg-white/[0.02] p-5 text-center text-sm text-content-muted">
        Picking an existing folder is only available inside the desktop app.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Drill breadcrumb */}
      <nav aria-label="Folder location" className="flex flex-wrap items-center gap-1 text-xs">
        {path.map((crumb, i) => {
          const isLast = i === path.length - 1;
          return (
            <span key={`${crumb.id ?? "root"}-${i}`} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-content-faint" aria-hidden />}
              <button
                type="button"
                onClick={() => jumpTo(i)}
                aria-current={isLast ? "location" : undefined}
                className={cn(
                  "rounded px-1.5 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40",
                  isLast
                    ? "font-semibold text-content-primary"
                    : "text-content-muted hover:text-content-primary",
                )}
              >
                {crumb.name}
              </button>
            </span>
          );
        })}
      </nav>

      {/* Child node list */}
      <div className="max-h-64 overflow-y-auto rounded-card border border-glass-border">
        {children === null && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-content-muted">
            <Loader2 size={15} className="animate-spin" aria-hidden />
            Loading…
          </div>
        )}

        {children !== null && children.length === 0 && (
          <div className="px-3.5 py-8 text-center text-sm text-content-muted">
            {error ? (
              <span className="text-orange">{error}</span>
            ) : currentParent.id === null ? (
              "No goals yet. Create a new one instead."
            ) : (
              "This folder has no sub-folders. Select it above to import here."
            )}
          </div>
        )}

        {children !== null && children.length > 0 && (
          <ul className="divide-y divide-glass-border">
            {children.map((node) => {
              const selected = node.id === selectedId;
              const hasChildren = node.child_count > 0;
              const overCap = node.depth >= DEPTH_CAP;
              return (
                <li key={node.id} className="flex items-stretch bg-white/[0.02]">
                  <button
                    type="button"
                    onClick={() => onSelect(node)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "flex min-h-10 flex-1 items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-lime/40",
                      selected
                        ? "bg-lime/10 text-content-primary"
                        : "text-content-secondary hover:bg-white/[0.04] hover:text-content-primary",
                    )}
                  >
                    <Folder
                      size={16}
                      strokeWidth={2}
                      className={cn("shrink-0", selected ? "text-lime" : "text-content-faint")}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
                    <span className={cn("shrink-0 text-xs", overCap ? "text-orange/80" : "text-content-faint")}>
                      {node.material_count} file{node.material_count === 1 ? "" : "s"}
                    </span>
                    {selected && (
                      <span className="shrink-0 rounded-full bg-lime/15 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-lime">
                        Here
                      </span>
                    )}
                  </button>
                  {hasChildren && (
                    <button
                      type="button"
                      onClick={() => drillInto(node)}
                      aria-label={`Open ${node.name}`}
                      className="grid w-10 shrink-0 place-items-center border-l border-glass-border text-content-faint transition-colors hover:bg-white/[0.05] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-lime/40"
                    >
                      <ChevronRight size={16} strokeWidth={2} aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs text-content-faint">
        Click a folder to import here, or its arrow to open it. The picked folder nests inside your selection.
      </p>
    </div>
  );
}
