/**
 * TaskGlyph — the small semantic type icon shown inside a task block/row. Maps a task's
 * icon kind (from `taskIconKind`) to a lucide glyph so a linked video/pdf/note/image/audio
 * reads at a glance, while an unlinked task shows a generic checklist mark. Shared by the
 * Timeline blocks, the Table, and the Legend so the vocabulary stays identical everywhere.
 */

import { Video, FileText, StickyNote, Image, Headphones, ListChecks } from "lucide-react";
import { taskIconKind, type TaskIconKind } from "./planningUtils";
import type { Task } from "../../lib/types";

const ICONS: Record<TaskIconKind, typeof Video> = {
  video: Video,
  pdf: FileText,
  note: StickyNote,
  image: Image,
  audio: Headphones,
  task: ListChecks,
};

export const ICON_KIND_LABEL: Record<TaskIconKind, string> = {
  video: "Video lesson",
  pdf: "PDF / document",
  note: "Note",
  image: "Image",
  audio: "Audio",
  task: "General task",
};

/** Ordered list for the legend (skips duplicates; stable, readable order). */
export const ICON_LEGEND_ORDER: TaskIconKind[] = ["task", "video", "pdf", "note", "audio", "image"];

export function GlyphFor({ kind, size = 12, className }: { kind: TaskIconKind; size?: number; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon size={size} strokeWidth={2} className={className} aria-hidden />;
}

export default function TaskGlyph({ task, size = 12, className }: { task: Task; size?: number; className?: string }) {
  return <GlyphFor kind={taskIconKind(task)} size={size} className={className} />;
}
