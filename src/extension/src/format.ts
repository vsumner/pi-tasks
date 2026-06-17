import { indexById, type TaskItem, type TaskStatus, type TaskSubagentRef } from "./task-state.ts";

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

export function unresolvedBlockers(task: TaskItem, allTasks?: TaskItem[]): string[] {
  if (!allTasks) return [...task.blockedBy];
  const byId = indexById(allTasks);
  return task.blockedBy.filter((id) => byId.get(id)?.status !== "completed");
}

export function formatTaskLine(task: TaskItem, allTasks?: TaskItem[]): string {
  const openBlockers = unresolvedBlockers(task, allTasks);
  const blockers = openBlockers.length > 0 ? ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]` : "";
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

// ---------------------------------------------------------------------------
// Run output file affordances
//
// Async/background runs can record saved output files, artifact outputs, and
// session transcripts on the subagent ref. These helpers surface those paths as
// compact "read the output file" guidance without dumping file contents into
// model/user context (mirrors Claude's read-the-output-file UX for background
// agents).
// ---------------------------------------------------------------------------

export interface RunOutputPaths {
  savedOutputs: string[];
  artifactOutputs: string[];
  sessionFiles: string[];
}

function dedupeStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

/** Collect deduplicated saved/artifact/session paths from a subagent ref. */
export function runOutputPaths(
  ref: Pick<TaskSubagentRef, "savedOutputs" | "artifactOutputs" | "sessionFiles"> | undefined | null,
): RunOutputPaths {
  if (!ref) return { savedOutputs: [], artifactOutputs: [], sessionFiles: [] };
  return {
    savedOutputs: dedupeStrings(ref.savedOutputs),
    artifactOutputs: dedupeStrings(ref.artifactOutputs),
    sessionFiles: dedupeStrings(ref.sessionFiles),
  };
}

export function hasRunOutputFiles(paths: RunOutputPaths): boolean {
  return paths.savedOutputs.length > 0 || paths.artifactOutputs.length > 0 || paths.sessionFiles.length > 0;
}

/** Primary file a reader should open: the saved output, falling back to the first artifact. */
export function primarySavedOutput(paths: RunOutputPaths): string | undefined {
  return paths.savedOutputs[0] ?? paths.artifactOutputs[0];
}

/**
 * Build the "Output files" section for TaskOutput. Leads with saved output
 * paths and tells the reader to read the saved output file for the full result,
 * followed by artifact outputs and the session transcript as reference.
 */
export function formatOutputFilesSection(paths: RunOutputPaths): string | undefined {
  if (!hasRunOutputFiles(paths)) return undefined;
  const groups: string[] = [];
  if (paths.savedOutputs.length > 0) {
    groups.push(["Saved output — read this file for the full result:", ...paths.savedOutputs.map((p) => `  ${p}`)].join("\n"));
  }
  if (paths.artifactOutputs.length > 0) {
    groups.push(["Artifact output:", ...paths.artifactOutputs.map((p) => `  ${p}`)].join("\n"));
  }
  if (paths.sessionFiles.length > 0) {
    groups.push(["Subagent session transcript (reference only):", ...paths.sessionFiles.map((p) => `  ${p}`)].join("\n"));
  }
  return `## Output files\n${groups.join("\n")}`;
}

/**
 * Compact one-line read-output guidance appended to async launch/complete
 * summaries. Returns undefined when no output path is known. Points at the
 * primary saved output, falling back to the session transcript when only that
 * is available.
 */
export function outputReadHint(paths: RunOutputPaths): string | undefined {
  const primary = primarySavedOutput(paths);
  if (primary) return `output saved to ${primary}; read it for the full result`;
  if (paths.sessionFiles[0]) return `session transcript at ${paths.sessionFiles[0]}`;
  return undefined;
}
