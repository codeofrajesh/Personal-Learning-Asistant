/**
 * NotesPanel — timestamped notes for the active material (v5 feature).
 *
 * "Add note at current time" grabs the live playback position from `playerBridge` and
 * creates a note anchored there. Each note is a card showing its timestamp as a
 * click-to-seek chip (jumps the player to that moment), the body, and edit/delete
 * affordances. Notes are sorted by timestamp. Optimistic where cheap; reloads from the
 * backend after each mutation to stay authoritative.
 *
 * Glass treatment consistent with the app DNA; fully keyboard-operable.
 */

import { useCallback, useEffect, useState } from "react";
import { Plus, Clock, Pencil, Trash2, Check, X } from "lucide-react";
import { ipc, isTauri } from "../../lib/ipc";
import { playerBridge } from "../../lib/playerBridge";
import { formatDuration } from "../../lib/utils";
import { cn } from "../../lib/utils";
import type { Note } from "../../lib/types";

interface Props {
  materialId: number;
}

export default function NotesPanel({ materialId }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [draftTs, setDraftTs] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    try {
      setNotes(await ipc.listNotes(materialId));
    } catch {
      /* keep prior list */
    } finally {
      setLoading(false);
    }
  }, [materialId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Begin a new note anchored at the current playback time.
  const startAdd = () => {
    setDraftTs(Math.floor(playerBridge.now()));
    setDraft("");
  };

  const saveAdd = async () => {
    const body = draft.trim();
    if (!body || draftTs == null) return;
    try {
      await ipc.createNote(materialId, draftTs, body);
      setDraft("");
      setDraftTs(null);
      await load();
    } catch {
      /* leave the draft so the user can retry */
    }
  };

  const saveEdit = async (id: number) => {
    const body = editBody.trim();
    if (!body) return;
    try {
      await ipc.updateNote(id, body);
      setEditingId(null);
      setEditBody("");
      await load();
    } catch {
      /* ignore */
    }
  };

  const remove = async (id: number) => {
    // Optimistic removal.
    setNotes((prev) => prev.filter((n) => n.id !== id));
    try {
      await ipc.deleteNote(id);
    } catch {
      void load(); // restore on failure
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Add bar */}
      <div className="shrink-0 pb-3">
        {draftTs == null ? (
          <button
            type="button"
            onClick={startAdd}
            disabled={!playerBridge.isBound()}
            className="flex w-full items-center justify-center gap-2 rounded-btn border border-lime/30 bg-lime/10 px-3 py-2 text-sm font-semibold text-lime transition-colors hover:bg-lime/15 disabled:opacity-40"
          >
            <Plus size={15} strokeWidth={2.5} aria-hidden />
            Add note at current time
          </button>
        ) : (
          <div className="rounded-[14px] border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-lime">
              <Clock size={13} strokeWidth={2} aria-hidden />
              <span className="tabular-nums">{formatDuration(draftTs)}</span>
            </div>
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void saveAdd();
                } else if (e.key === "Escape") {
                  setDraftTs(null);
                  setDraft("");
                }
              }}
              placeholder="What's happening at this moment?"
              rows={3}
              className="w-full resize-none rounded-btn bg-white/[0.04] px-3 py-2 text-sm text-content-primary placeholder:text-content-faint focus:outline-none focus:ring-2 focus:ring-lime/40"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => { setDraftTs(null); setDraft(""); }}
                className="rounded-btn px-3 py-1 text-xs text-content-secondary transition-colors hover:bg-white/[0.06]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveAdd()}
                disabled={!draft.trim()}
                className="rounded-btn bg-lime px-3 py-1 text-xs font-semibold text-ink-900 transition-transform hover:scale-[1.03] disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Notes list */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        {loading ? (
          <p className="py-6 text-center text-xs text-content-faint">Loading notes…</p>
        ) : notes.length === 0 ? (
          <p className="py-6 text-center text-xs text-content-faint">
            No notes yet. Jump to a moment and add your first one.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((n) => (
              <li key={n.id} className="cv-row group rounded-[14px] border border-white/[0.06] bg-white/[0.03] p-3">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => playerBridge.seek(n.timestamp_secs)}
                    className="flex items-center gap-1.5 rounded-full bg-lime/10 px-2 py-0.5 text-xs font-semibold text-lime transition-colors hover:bg-lime/20"
                    aria-label={`Seek to ${formatDuration(n.timestamp_secs)}`}
                  >
                    <Clock size={12} strokeWidth={2} aria-hidden />
                    <span className="tabular-nums">{formatDuration(n.timestamp_secs)}</span>
                  </button>
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={() => { setEditingId(n.id); setEditBody(n.body); }}
                      aria-label="Edit note"
                      className="grid h-7 w-7 place-items-center rounded-full text-content-muted transition-colors hover:bg-white/[0.06] hover:text-content-primary"
                    >
                      <Pencil size={13} strokeWidth={2} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(n.id)}
                      aria-label="Delete note"
                      className="grid h-7 w-7 place-items-center rounded-full text-content-muted transition-colors hover:bg-red-400/10 hover:text-red-400"
                    >
                      <Trash2 size={13} strokeWidth={2} aria-hidden />
                    </button>
                  </div>
                </div>

                {editingId === n.id ? (
                  <div className="mt-2">
                    <textarea
                      autoFocus
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void saveEdit(n.id);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      rows={3}
                      className="w-full resize-none rounded-btn bg-white/[0.04] px-3 py-2 text-sm text-content-primary focus:outline-none focus:ring-2 focus:ring-lime/40"
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="grid h-7 w-7 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06]"
                        aria-label="Cancel edit"
                      >
                        <X size={14} strokeWidth={2} aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveEdit(n.id)}
                        disabled={!editBody.trim()}
                        className="grid h-7 w-7 place-items-center rounded-full bg-lime text-ink-900 transition-transform hover:scale-105 disabled:opacity-40"
                        aria-label="Save edit"
                      >
                        <Check size={14} strokeWidth={2.5} aria-hidden />
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className={cn("mt-2 whitespace-pre-wrap text-sm leading-relaxed text-content-secondary")}>{n.body}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
