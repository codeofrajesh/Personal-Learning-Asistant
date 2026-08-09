/**
 * CourseTreeBuilder — the Visual Course Builder overlay.
 *
 * Renders the existing node tree as an interactive, structured diagram with
 * indented rows, SVG connector lines, and inline editing. The user can:
 *
 *   - Create subfolders at any depth via a "+" button on each node.
 *   - Rename any node by double-clicking its name (inline edit, no modal).
 *   - Navigate to the Telegram import page targeting a specific node.
 *   - Collapse / expand branches with a smooth GSAP animation.
 *
 * The component loads the full tree recursively via `ipc.nodeChildren` and
 * renders it as a flat indented list (with SVG vertical + horizontal connector
 * lines) for simplicity and scroll performance.
 *
 * **Design principle (frontend-design skill):** The one signature element is
 * the live connector-line diagram — everything else (type, spacing, color) is
 * kept quiet and disciplined so the tree itself is the focal point.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  ChevronRight,
  FolderPlus,
  FolderOpen,
  Pencil,
  Check,
  X,
  Loader2,
  Send,
} from "lucide-react";
import { ipc } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import { motionAllowed } from "../../lib/perfStore";
import type { NodeCard } from "../../lib/types";

gsap.registerPlugin(useGSAP);

/** A tree node augmented with UI state. */
interface TreeNode {
  data: NodeCard;
  children: TreeNode[];
  expanded: boolean;
  loading: boolean;
}

interface CourseTreeBuilderProps {
  /** Close the builder overlay. */
  onClose: () => void;
  /** The current node id the user is browsing (or null for root). */
  currentNodeId: number | null;
}

export default function CourseTreeBuilder({
  onClose,
  currentNodeId,
}: CourseTreeBuilderProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<{
    parentId: number | null;
    name: string;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const [renaming, setRenaming] = useState<{
    nodeId: number;
    name: string;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // ── Load root nodes on mount ──────────────────────────────────────────────
  const loadRoots = useCallback(async () => {
    setLoading(true);
    try {
      const cards = await ipc.nodeChildren(null);
      setRoots(
        cards.map((c) => ({
          data: c,
          children: [],
          expanded: false,
          loading: false,
        }))
      );
    } catch {
      /* empty roots */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  // ── Entrance animation ────────────────────────────────────────────────────
  useGSAP(
    () => {
      if (!motionAllowed() || loading) return;
      gsap.from(".tree-node-row", {
        y: 12,
        opacity: 0,
        stagger: 0.04,
        duration: 0.4,
        ease: "power3.out",
      });
    },
    { dependencies: [loading], scope: rootRef }
  );

  // ── Toggle expand / collapse ──────────────────────────────────────────────
  const toggleExpand = useCallback(
    async (nodeId: number) => {
      const update = (
        nodes: TreeNode[],
        id: number,
        fn: (n: TreeNode) => TreeNode
      ): TreeNode[] =>
        nodes.map((n) =>
          n.data.id === id
            ? fn(n)
            : { ...n, children: update(n.children, id, fn) }
        );

      // If already expanded, just collapse.
      const find = (nodes: TreeNode[], id: number): TreeNode | null => {
        for (const n of nodes) {
          if (n.data.id === id) return n;
          const found = find(n.children, id);
          if (found) return found;
        }
        return null;
      };

      const node = find(roots, nodeId);
      if (!node) return;

      if (node.expanded) {
        setRoots((r) =>
          update(r, nodeId, (n) => ({ ...n, expanded: false }))
        );
        return;
      }

      // Load children if empty.
      if (node.children.length === 0) {
        setRoots((r) =>
          update(r, nodeId, (n) => ({ ...n, loading: true }))
        );
        try {
          const children = await ipc.nodeChildren(nodeId);
          setRoots((r) =>
            update(r, nodeId, (n) => ({
              ...n,
              loading: false,
              expanded: true,
              children: children.map((c) => ({
                data: c,
                children: [],
                expanded: false,
                loading: false,
              })),
            }))
          );
        } catch {
          setRoots((r) =>
            update(r, nodeId, (n) => ({ ...n, loading: false }))
          );
        }
      } else {
        setRoots((r) =>
          update(r, nodeId, (n) => ({ ...n, expanded: true }))
        );
      }
    },
    [roots]
  );

  // ── Create node ───────────────────────────────────────────────────────────
  const startCreate = (parentId: number | null) => {
    setCreating({ parentId, name: "", busy: false, error: null });
    setRenaming(null);
  };

  const commitCreate = async () => {
    if (!creating || !creating.name.trim()) return;
    setCreating((c) => (c ? { ...c, busy: true, error: null } : c));
    try {
      await ipc.createNode(creating.parentId, creating.name.trim());
      setCreating(null);
      // Reload the whole tree to pick up the new node.
      await loadRoots();
    } catch (e) {
      setCreating((c) =>
        c
          ? { ...c, busy: false, error: e instanceof Error ? e.message : String(e) }
          : c
      );
    }
  };

  // ── Rename node ───────────────────────────────────────────────────────────
  const startRename = (nodeId: number, currentName: string) => {
    setRenaming({ nodeId, name: currentName, busy: false, error: null });
    setCreating(null);
  };

  const commitRename = async () => {
    if (!renaming || !renaming.name.trim()) return;
    setRenaming((r) => (r ? { ...r, busy: true, error: null } : r));
    try {
      await ipc.renameNode(renaming.nodeId, renaming.name.trim());
      setRenaming(null);
      await loadRoots();
    } catch (e) {
      setRenaming((r) =>
        r
          ? { ...r, busy: false, error: e instanceof Error ? e.message : String(e) }
          : r
      );
    }
  };

  // ── Navigate to Telegram import targeting a specific node ─────────────────
  const importToNode = (nodeId: number) => {
    navigate(`/plugins/telegram?targetNodeId=${nodeId}`);
    onClose();
  };

  // ── Flatten tree to rows ──────────────────────────────────────────────────
  interface FlatRow {
    node: TreeNode;
    depth: number;
    isLast: boolean;
    /** Which ancestor depths have a sibling below them (need a vertical line). */
    continuations: Set<number>;
  }

  const flatten = (
    nodes: TreeNode[],
    depth: number,
    continuations: Set<number>
  ): FlatRow[] => {
    const rows: FlatRow[] = [];
    nodes.forEach((node, i) => {
      const isLast = i === nodes.length - 1;
      const nextConts = new Set(continuations);
      if (!isLast) nextConts.add(depth);
      else nextConts.delete(depth);

      rows.push({ node, depth, isLast, continuations: new Set(continuations) });

      if (node.expanded && node.children.length > 0) {
        rows.push(...flatten(node.children, depth + 1, nextConts));
      }
    });
    return rows;
  };

  const flatRows = flatten(roots, 0, new Set());
  const INDENT = 32; // px per depth level

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#060608]/80 backdrop-blur-3xl p-4 md:p-6 lg:p-8">
      {/* Noise Texture Overlay */}
      <div 
        className="pointer-events-none absolute inset-0 opacity-[0.04]" 
        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")` }}
      />
      {/* Premium Floating Window */}
      <div className="relative z-10 flex flex-1 flex-col overflow-hidden rounded-2xl bg-[#0a0b0d]/90 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] border border-white/[0.08]">
        {/* Subtle inner highlight for 3D feel */}
        <div className="pointer-events-none absolute inset-0 rounded-2xl border border-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]" />
        
        {/* Header */}
        <header className="relative z-20 flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-6 py-5">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-white drop-shadow-sm">
              Course Builder
            </h2>
            <p className="mt-1 text-xs font-medium text-content-muted">
              Create and organise your folder structure
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => startCreate(null)}
              className="inline-flex items-center gap-2 rounded-full border border-lime/30 bg-gradient-to-b from-lime/[0.15] to-lime/[0.05] px-4 py-2 text-sm font-semibold text-lime transition-all duration-300 hover:border-lime/60 hover:from-lime/[0.2] hover:to-lime/[0.1] hover:shadow-[0_0_20px_rgba(163,230,53,0.2),inset_0_1px_0_rgba(255,255,255,0.2)] hover:-translate-y-0.5"
            >
              <FolderPlus size={16} strokeWidth={2} aria-hidden />
              New Course
            </button>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-content-muted transition-all duration-200 hover:bg-white/[0.08] hover:text-white"
              aria-label="Close builder"
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </header>

        {/* Tree body */}
        <div ref={rootRef} className="relative z-20 flex-1 overflow-y-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-content-muted">
            <Loader2 size={18} className="animate-spin" />
            Loading courses…
          </div>
        ) : roots.length === 0 && !creating ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <div className="grid h-16 w-16 place-items-center rounded-2xl border border-dashed border-white/15 bg-white/[0.02]">
              <FolderOpen
                size={28}
                strokeWidth={1.5}
                className="text-content-muted"
              />
            </div>
            <p className="text-sm text-content-muted">
              No courses yet. Create your first one!
            </p>
            <button
              type="button"
              onClick={() => startCreate(null)}
              className="inline-flex items-center gap-2 rounded-full border border-lime/20 bg-gradient-to-b from-lime to-lime-500 px-5 py-2.5 text-sm font-bold text-ink-900 shadow-[0_0_20px_rgba(163,230,53,0.3),inset_0_1px_0_rgba(255,255,255,0.4)] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_25px_rgba(163,230,53,0.4),inset_0_1px_0_rgba(255,255,255,0.4)]"
            >
              <FolderPlus size={15} strokeWidth={2} aria-hidden />
              New Course
            </button>
          </div>
        ) : (
          <div className="relative mx-auto max-w-3xl">
            {/* Inline create at root level */}
            {creating && creating.parentId === null && (
              <InlineCreate
                value={creating.name}
                onChange={(name) =>
                  setCreating((c) => (c ? { ...c, name } : c))
                }
                onCommit={commitCreate}
                onCancel={() => setCreating(null)}
                busy={creating.busy}
                error={creating.error}
                depth={0}
                indent={INDENT}
              />
            )}

            {flatRows.map((row) => {
              const { node, depth, isLast, continuations } = row;
              const isRenaming = renaming?.nodeId === node.data.id;
              const isCreatingChild =
                creating?.parentId === node.data.id;

              return (
                <div key={node.data.id}>
                  {/* SVG connector lines */}
                  <div
                    className="tree-node-row group relative flex min-h-[44px] items-center transition-transform duration-200 hover:-translate-y-[1px]"
                    style={{ paddingLeft: depth * INDENT }}
                  >
                    {/* Vertical continuation lines from ancestors */}
                    {depth > 0 && (
                      <svg
                        className="pointer-events-none absolute left-0 top-0 h-full"
                        style={{ width: depth * INDENT }}
                        aria-hidden
                      >
                        <defs>
                          <linearGradient id="glow-vert" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="rgba(255,255,255,0.03)" />
                            <stop offset="50%" stopColor="rgba(255,255,255,0.15)" />
                            <stop offset="100%" stopColor="rgba(255,255,255,0.03)" />
                          </linearGradient>
                          <linearGradient id="glow-horiz" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="rgba(255,255,255,0.03)" />
                            <stop offset="100%" stopColor="rgba(255,255,255,0.15)" />
                          </linearGradient>
                        </defs>
                        {/* Continuation lines for ancestors that have more siblings below */}
                        {Array.from(continuations).map((d) => (
                          <line
                            key={d}
                            x1={d * INDENT + 12}
                            y1={0}
                            x2={d * INDENT + 12}
                            y2="100%"
                            stroke="url(#glow-vert)"
                            strokeWidth={1.5}
                          />
                        ))}
                        {/* Horizontal connector to this node */}
                        <line
                          x1={(depth - 1) * INDENT + 12}
                          y1={isLast ? 22 : 22}
                          x2={depth * INDENT - 4}
                          y2={22}
                          stroke="url(#glow-horiz)"
                          strokeWidth={1.5}
                        />
                        {/* Vertical segment down to this node */}
                        <line
                          x1={(depth - 1) * INDENT + 12}
                          y1={0}
                          x2={(depth - 1) * INDENT + 12}
                          y2={isLast ? 22 : "100%"}
                          stroke="url(#glow-vert)"
                          strokeWidth={1.5}
                        />
                      </svg>
                    )}

                    {/* Expand/collapse chevron */}
                    <button
                      type="button"
                      onClick={() => void toggleExpand(node.data.id)}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-content-muted transition-all duration-200 hover:bg-white/[0.08] hover:text-white"
                      aria-label={
                        node.expanded ? "Collapse" : "Expand"
                      }
                    >
                      {node.loading ? (
                        <Loader2
                          size={14}
                          className="animate-spin text-cyan-400"
                        />
                      ) : (
                        <ChevronRight
                          size={14}
                          strokeWidth={2.5}
                          className={cn(
                            "transition-transform duration-200",
                            node.expanded && "rotate-90"
                          )}
                        />
                      )}
                    </button>

                    {/* Folder icon */}
                    <div
                      className={cn(
                        "mr-3 grid h-9 w-9 shrink-0 place-items-center rounded-xl border shadow-sm transition-all duration-300",
                        node.data.id === currentNodeId
                          ? "border-cyan-400/40 bg-gradient-to-b from-cyan-400/20 to-cyan-400/5 text-cyan-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_0_15px_rgba(34,211,238,0.2)]"
                          : "border-white/[0.08] bg-gradient-to-b from-white/[0.08] to-transparent text-content-muted group-hover:border-white/20 group-hover:text-content-primary group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]"
                      )}
                    >
                      <FolderOpen size={16} strokeWidth={1.8} />
                    </div>

                    {/* Name (or inline rename) */}
                    {isRenaming ? (
                      <InlineRename
                        value={renaming!.name}
                        onChange={(name) =>
                          setRenaming((r) =>
                            r ? { ...r, name } : r
                          )
                        }
                        onCommit={commitRename}
                        onCancel={() => setRenaming(null)}
                        busy={renaming!.busy}
                        error={renaming!.error}
                      />
                    ) : (
                      <button
                        type="button"
                        onDoubleClick={() =>
                          startRename(node.data.id, node.data.name)
                        }
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium text-content-primary transition-colors hover:text-white"
                        title="Double-click to rename"
                      >
                        {node.data.name}
                      </button>
                    )}

                    {/* Counts badge */}
                    <span className="ml-3 shrink-0 rounded-full border border-white/[0.04] bg-white/[0.03] px-2.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-content-muted shadow-sm transition-colors duration-300 group-hover:bg-white/[0.06] group-hover:text-content-secondary">
                      {node.data.child_count > 0 &&
                        `${node.data.child_count} folder${
                          node.data.child_count !== 1 ? "s" : ""
                        }`}
                      {node.data.child_count > 0 &&
                        node.data.material_count > 0 &&
                        " · "}
                      {node.data.material_count > 0 &&
                        `${node.data.material_count} file${
                          node.data.material_count !== 1 ? "s" : ""
                        }`}
                    </span>

                    {/* Action buttons — revealed on hover */}
                    <div className="ml-3 flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => startRename(node.data.id, node.data.name)}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-content-muted transition-all hover:border-white/10 hover:bg-white/[0.08] hover:text-white hover:shadow-sm"
                        title="Rename"
                      >
                        <Pencil size={14} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => startCreate(node.data.id)}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-content-muted transition-all hover:border-lime/30 hover:bg-gradient-to-b hover:from-lime/20 hover:to-lime/5 hover:text-lime hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_10px_rgba(163,230,53,0.15)]"
                        title="Add subfolder"
                      >
                        <FolderPlus size={15} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => importToNode(node.data.id)}
                        className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-content-muted transition-all hover:border-cyan-400/30 hover:bg-gradient-to-b hover:from-cyan-400/20 hover:to-cyan-400/5 hover:text-cyan-400 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_10px_rgba(34,211,238,0.15)]"
                        title="Import Telegram media"
                      >
                        <Send size={14} strokeWidth={2} />
                      </button>
                    </div>
                  </div>

                  {/* Inline create for this node's children */}
                  {isCreatingChild && node.expanded && (
                    <InlineCreate
                      value={creating!.name}
                      onChange={(name) =>
                        setCreating((c) => (c ? { ...c, name } : c))
                      }
                      onCommit={commitCreate}
                      onCancel={() => setCreating(null)}
                      busy={creating!.busy}
                      error={creating!.error}
                      depth={depth + 1}
                      indent={INDENT}
                    />
                  )}

                  {/* If creating child but node is collapsed, expand it first */}
                  {isCreatingChild && !node.expanded && (
                    <ExpandAndCreate
                      nodeId={node.data.id}
                      onExpanded={() => void toggleExpand(node.data.id)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

/** Inline text input for creating a new folder. */
function InlineCreate({
  value,
  onChange,
  onCommit,
  onCancel,
  busy,
  error,
  depth,
  indent,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
  depth: number;
  indent: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="flex flex-col gap-1 py-1.5"
      style={{ paddingLeft: depth * indent + 7 }}
    >
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-dashed border-lime/30 bg-lime/[0.05] text-lime">
          <FolderPlus size={14} strokeWidth={2} />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onCommit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Folder name…"
          disabled={busy}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-content-primary placeholder:text-content-muted/50 outline-none transition-colors focus:border-lime/40 focus:bg-white/[0.06] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void onCommit()}
          disabled={busy || !value.trim()}
          className="grid h-7 w-7 place-items-center rounded-md bg-lime/15 text-lime transition-colors hover:bg-lime/25 disabled:opacity-40"
          title="Create"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Check size={14} strokeWidth={2.5} />
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="grid h-7 w-7 place-items-center rounded-md text-content-muted transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          title="Cancel"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      {error && (
        <p className="ml-10 text-xs text-orange-400">{error}</p>
      )}
    </div>
  );
}

/** Inline rename input. */
function InlineRename({
  value,
  onChange,
  onCommit,
  onCancel,
  busy,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onCommit();
            if (e.key === "Escape") onCancel();
          }}
          disabled={busy}
          className="min-w-0 flex-1 rounded-lg border border-cyan-400/30 bg-cyan-400/[0.06] px-3 py-1 text-sm text-content-primary outline-none transition-colors focus:border-cyan-400/50 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void onCommit()}
          disabled={busy || !value.trim()}
          className="grid h-7 w-7 place-items-center rounded-md bg-cyan-400/15 text-cyan-400 transition-colors hover:bg-cyan-400/25 disabled:opacity-40"
          title="Save"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Check size={14} strokeWidth={2.5} />
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="grid h-7 w-7 place-items-center rounded-md text-content-muted transition-colors hover:bg-white/[0.06]"
          title="Cancel"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      {error && <p className="text-xs text-orange-400">{error}</p>}
    </div>
  );
}

/** Auto-expands a node when the user clicks "+ subfolder" on a collapsed branch. */
function ExpandAndCreate({
  nodeId,
  onExpanded,
}: {
  nodeId: number;
  onExpanded: () => void;
}) {
  useEffect(() => {
    onExpanded();
  }, [nodeId, onExpanded]);

  return null;
}
