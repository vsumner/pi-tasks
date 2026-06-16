import type { TaskItem, TaskStatus } from "./task-state.ts";

export function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "completed": return "✔";
    case "in_progress": return "◼";
    case "blocked": return "⊘";
    case "failed": return "✖";
    case "cancelled": return "◌";
    case "pending": return "◻";
  }
}

export function statusRank(status: TaskStatus): number {
  switch (status) {
    case "in_progress": return 0;
    case "pending": return 1;
    case "blocked": return 2;
    case "failed": return 3;
    case "completed": return 4;
    case "cancelled": return 5;
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function formatTaskLine(task: TaskItem): string {
  const blockers = task.blockedBy.length > 0 ? ` [blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ")}]` : "";
  const owner = task.owner ? ` (${task.owner})` : "";
  return `#${task.id} [${task.status}] ${task.title}${owner}${blockers}`;
}

export function taskStats(tasks: TaskItem[]): string {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.filter((t) => t.status === "in_progress").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const open = tasks.filter((t) => t.status === "pending").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const cancelled = tasks.filter((t) => t.status === "cancelled").length;
  const parts: string[] = [];
  if (completed) parts.push(`${completed} done`);
  if (active) parts.push(`${active} active`);
  if (open) parts.push(`${open} open`);
  if (blocked) parts.push(`${blocked} blocked`);
  if (failed) parts.push(`${failed} failed`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return `${total} task${total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

export function textBlock(content: Array<{ type?: string; text?: string }> | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}
