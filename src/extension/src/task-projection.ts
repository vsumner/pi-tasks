// ---------------------------------------------------------------------------
// Project pi-tasks state from Pi session branch entries
// ---------------------------------------------------------------------------

import { TASK_EVENT_TYPES } from "./events.ts";
import { projectTasksFromEvents, type TaskEvent, type TaskItem } from "./task-state.ts";

export type BranchSessionContext = {
  sessionManager: {
    getBranch?: () => unknown[];
  };
};

function entryTimestamp(entry: Record<string, unknown>): string {
  return typeof entry.timestamp === "string"
    ? entry.timestamp
    : typeof entry.ts === "string"
      ? entry.ts
      : new Date().toISOString();
}

function entryToTaskEvent(entry: Record<string, unknown>): TaskEvent | null {
  if (entry.type === "custom" && typeof entry.customType === "string" && TASK_EVENT_TYPES.has(entry.customType)) {
    return {
      type: "custom",
      customType: entry.customType,
      data: typeof entry.data === "object" && entry.data !== null ? entry.data as Record<string, unknown> : {},
      ts: entryTimestamp(entry),
    };
  }

  // Compatibility with early/prototype tool-result state, if any exists.
  if (entry.type === "message") {
    const message = entry.message as Record<string, unknown> | undefined;
    if (message?.role === "toolResult" && typeof message.toolName === "string" && message.toolName.startsWith("Task")) {
      const details = message.details as Record<string, unknown> | undefined;
      const event = details?.taskEvent as TaskEvent | undefined;
      if (event && typeof event.customType === "string" && TASK_EVENT_TYPES.has(event.customType)) {
        return { ...event, ts: event.ts ?? entryTimestamp(entry) };
      }
    }
  }

  return null;
}

export function getBranchTaskEvents(ctx: BranchSessionContext): TaskEvent[] {
  const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
  const events: TaskEvent[] = [];
  for (const entry of branch) {
    if (typeof entry !== "object" || entry === null) continue;
    const event = entryToTaskEvent(entry as Record<string, unknown>);
    if (event) events.push(event);
  }
  return events;
}

export function projectTasks(ctx: BranchSessionContext): TaskItem[] {
  return projectTasksFromEvents(getBranchTaskEvents(ctx));
}
