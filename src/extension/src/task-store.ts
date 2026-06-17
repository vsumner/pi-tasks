// ---------------------------------------------------------------------------
// Session-backed task store (in-memory projection + event appender)
// ---------------------------------------------------------------------------

import {
  TASK_CLEARED_EVENT,
  TASK_CREATED_EVENT,
  TASK_EVENT_VERSION,
  TASK_DELETED_EVENT,
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_RUN_FINISHED_EVENT,
  TASK_RUN_STARTED_EVENT,
  TASK_SNAPSHOT_EVENT,
  TASK_STATUS_UPDATED_EVENT,
  TASK_UPDATED_EVENT,
} from "./events.ts";
import {
  applyTaskEventToMap,
  compareTasks,
  createTask as createTaskState,
  makeEvidence,
  readyTasks,
  type TaskAcceptance,
  type TaskCreateInput,
  type TaskEvent,
  type TaskEvidence,
  type TaskItem,
  type TaskKind,
  type TaskPatch,
  type TaskRunRecord,
  type TaskRunStatus,
  type TaskStatus,
  type TaskSubagentRef,
} from "./task-state.ts";

export type {
  TaskAcceptance,
  TaskCreateInput,
  TaskEvent,
  TaskEvidence,
  TaskItem,
  TaskKind,
  TaskPatch,
  TaskRunRecord,
  TaskRunStatus,
  TaskStatus,
  TaskSubagentRef,
};

export interface TaskUpdateInput extends TaskPatch {
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
}

const tasksByCwd = new Map<string, Map<string, TaskItem>>();
let eventAppender: ((event: TaskEvent) => void) | undefined;
let appendSuppressionDepth = 0;

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getCwdMap(cwd: string): Map<string, TaskItem> {
  let map = tasksByCwd.get(cwd);
  if (!map) {
    map = new Map();
    tasksByCwd.set(cwd, map);
  }
  return map;
}

function makeEvent(customType: string, data: Record<string, unknown>): TaskEvent {
  return { type: "custom", customType, data: { version: TASK_EVENT_VERSION, ...data }, ts: now() };
}

function appendEvent(event: TaskEvent): void {
  if (appendSuppressionDepth > 0) return;
  if (!eventAppender) throw new Error("Task session event appender is not configured.");
  eventAppender(event);
}

function emit(cwd: string, event: TaskEvent): void {
  const scopedEvent = { ...event, scope: cwd };
  appendEvent(scopedEvent);
  tasksByCwd.set(cwd, applyTaskEventToMap(getCwdMap(cwd), scopedEvent));
}

function nextId(cwd: string): string {
  let max = 0;
  for (const id of getCwdMap(cwd).keys()) {
    const n = Number(id);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return String(max + 1);
}

function getTaskOrThrow(cwd: string, taskId: string): TaskItem {
  const task = getCwdMap(cwd).get(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  return clone(task);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0)));
}

function normalizeStatus(status: unknown, fallback: TaskStatus): TaskStatus {
  if (
    status === "pending" ||
    status === "in_progress" ||
    status === "blocked" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return fallback;
}

function normalizeKind(kind: unknown, fallback: TaskKind): TaskKind {
  if (kind === "manual" || kind === "subagent" || kind === "packet") return kind;
  return fallback;
}

function mergeMetadata(current: Record<string, unknown>, patch: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!patch) return { ...current };
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function applyUpdate(task: TaskItem, update: TaskUpdateInput): TaskItem {
  const next = clone(task);
  if (typeof update.title === "string") next.title = update.title.trim();
  if (typeof update.prompt === "string") next.prompt = update.prompt.trim();
  if (update.status !== undefined) next.status = normalizeStatus(update.status, next.status);
  if (update.kind !== undefined) next.kind = normalizeKind(update.kind, next.kind);
  if (update.activeForm !== undefined) next.activeForm = update.activeForm?.trim() || undefined;
  if (update.agent !== undefined) next.agent = update.agent?.trim() || undefined;
  if (update.owner !== undefined) next.owner = update.owner?.trim() || undefined;
  if (update.source !== undefined) next.source = String(update.source || "agent");
  if (update.cwd !== undefined) next.cwd = update.cwd;
  if (update.acceptance !== undefined) next.acceptance = update.acceptance as TaskAcceptance | undefined;
  if (update.metadata !== undefined) next.metadata = mergeMetadata(next.metadata, update.metadata);

  if (update.blockedBy !== undefined) next.blockedBy = stringArray(update.blockedBy);
  if (update.blocks !== undefined) next.blocks = stringArray(update.blocks);

  for (const id of stringArray(update.addBlockedBy)) {
    if (!next.blockedBy.includes(id)) next.blockedBy.push(id);
  }
  for (const id of stringArray(update.addBlocks)) {
    if (!next.blocks.includes(id)) next.blocks.push(id);
  }
  const removeBlockedBy = new Set(stringArray(update.removeBlockedBy));
  if (removeBlockedBy.size > 0) next.blockedBy = next.blockedBy.filter((id) => !removeBlockedBy.has(id));
  const removeBlocks = new Set(stringArray(update.removeBlocks));
  if (removeBlocks.size > 0) next.blocks = next.blocks.filter((id) => !removeBlocks.has(id));

  next.updatedAt = now();
  return next;
}

function reciprocalUpdates(cwd: string, task: TaskItem, before?: TaskItem): TaskItem[] {
  const updates = new Map<string, TaskItem>();
  const map = getCwdMap(cwd);
  const beforeBlocks = new Set(before?.blocks ?? []);
  const beforeBlockedBy = new Set(before?.blockedBy ?? []);
  const afterBlocks = new Set(task.blocks);
  const afterBlockedBy = new Set(task.blockedBy);
  const ts = now();

  const touch = (id: string, fn: (other: TaskItem) => void) => {
    const other = updates.get(id) ?? map.get(id);
    if (!other) return;
    const next = updates.has(id) ? other : clone(other);
    fn(next);
    next.updatedAt = ts;
    updates.set(id, next);
  };

  for (const id of afterBlocks) {
    if (!beforeBlocks.has(id)) touch(id, (other) => {
      if (!other.blockedBy.includes(task.id)) other.blockedBy.push(task.id);
    });
  }
  for (const id of beforeBlocks) {
    if (!afterBlocks.has(id)) touch(id, (other) => {
      other.blockedBy = other.blockedBy.filter((candidate) => candidate !== task.id);
    });
  }
  for (const id of afterBlockedBy) {
    if (!beforeBlockedBy.has(id)) touch(id, (other) => {
      if (!other.blocks.includes(task.id)) other.blocks.push(task.id);
    });
  }
  for (const id of beforeBlockedBy) {
    if (!afterBlockedBy.has(id)) touch(id, (other) => {
      other.blocks = other.blocks.filter((candidate) => candidate !== task.id);
    });
  }

  return Array.from(updates.values());
}

function emitTaskSnapshot(cwd: string, task: TaskItem): TaskItem {
  emit(cwd, makeEvent(TASK_UPDATED_EVENT, { taskId: task.id, task }));
  return getTaskOrThrow(cwd, task.id);
}

export const taskStore = {
  setEventAppender(appender: (event: TaskEvent) => void): void {
    eventAppender = appender;
  },

  reset(): void {
    tasksByCwd.clear();
    eventAppender = undefined;
    appendSuppressionDepth = 0;
  },

  withoutAppending<T>(fn: () => T): T {
    appendSuppressionDepth += 1;
    try {
      return fn();
    } finally {
      appendSuppressionDepth -= 1;
    }
  },

  applyEvents(cwd: string, events: TaskEvent[]): void {
    let projected = new Map<string, TaskItem>();
    for (const event of events) projected = applyTaskEventToMap(projected, event);
    tasksByCwd.set(cwd, projected);
  },

  createTask(cwd: string, input: TaskCreateInput): TaskItem {
    if (!input.title.trim()) throw new Error("Task title is required.");
    if (!input.prompt.trim()) throw new Error("Task prompt is required.");
    const task = createTaskState(input, input.id ?? nextId(cwd));
    if (getCwdMap(cwd).has(task.id)) throw new Error(`Task #${task.id} already exists.`);
    emit(cwd, makeEvent(TASK_CREATED_EVENT, { taskId: task.id, task }));
    for (const other of reciprocalUpdates(cwd, task)) emitTaskSnapshot(cwd, other);
    return getTaskOrThrow(cwd, task.id);
  },

  readTask(cwd: string, taskId: string): TaskItem | null {
    const task = getCwdMap(cwd).get(taskId);
    return task ? clone(task) : null;
  },

  readAll(cwd: string): TaskItem[] {
    return Array.from(getCwdMap(cwd).values()).map(clone).sort(compareTasks);
  },

  ready(cwd: string): TaskItem[] {
    return readyTasks(getCwdMap(cwd).values()).map(clone);
  },

  updateTask(cwd: string, taskId: string, update: TaskUpdateInput): TaskItem {
    const before = getTaskOrThrow(cwd, taskId);
    const after = applyUpdate(before, update);
    emitTaskSnapshot(cwd, after);
    for (const other of reciprocalUpdates(cwd, after, before)) emitTaskSnapshot(cwd, other);
    return getTaskOrThrow(cwd, taskId);
  },

  updateStatus(cwd: string, taskId: string, status: TaskStatus, reason?: string): TaskItem {
    const current = getTaskOrThrow(cwd, taskId);
    const nextStatus = normalizeStatus(status, current.status);
    emit(cwd, makeEvent(TASK_STATUS_UPDATED_EVENT, { taskId, status: nextStatus, reason }));
    if (reason?.trim()) {
      emit(cwd, makeEvent(TASK_EVIDENCE_RECORDED_EVENT, { taskId, evidence: makeEvidence("note", reason.trim(), { source: TASK_STATUS_UPDATED_EVENT }) }));
    }
    return getTaskOrThrow(cwd, taskId);
  },

  deleteTask(cwd: string, taskId: string): void {
    getTaskOrThrow(cwd, taskId);
    emit(cwd, makeEvent(TASK_DELETED_EVENT, { taskId }));
  },

  clearCompleted(cwd: string): number {
    const before = Array.from(getCwdMap(cwd).values()).filter((task) => task.status === "completed").length;
    emit(cwd, makeEvent(TASK_CLEARED_EVENT, { scope: "completed" }));
    return before;
  },

  clearAll(cwd: string): number {
    const before = getCwdMap(cwd).size;
    emit(cwd, makeEvent(TASK_CLEARED_EVENT, { scope: "all" }));
    return before;
  },

  snapshot(cwd: string): number {
    const tasks = Array.from(getCwdMap(cwd).values()).map(clone).sort(compareTasks);
    emit(cwd, makeEvent(TASK_SNAPSHOT_EVENT, { tasks }));
    return tasks.length;
  },

  startRun(cwd: string, taskId: string, run: TaskRunRecord): TaskItem {
    getTaskOrThrow(cwd, taskId);
    emit(cwd, makeEvent(TASK_RUN_STARTED_EVENT, { taskId, run }));
    return getTaskOrThrow(cwd, taskId);
  },

  finishRun(
    cwd: string,
    taskId: string,
    status: TaskRunStatus,
    opts: {
      summary?: string;
      error?: string;
      output?: string;
      usage?: TaskRunRecord["usage"];
      subagent?: Partial<TaskSubagentRef>;
    } = {},
  ): TaskItem {
    getTaskOrThrow(cwd, taskId);
    emit(cwd, makeEvent(TASK_RUN_FINISHED_EVENT, { taskId, status, ...opts }));
    return getTaskOrThrow(cwd, taskId);
  },

  recordEvidence(cwd: string, taskId: string, evidence: TaskEvidence): TaskItem {
    getTaskOrThrow(cwd, taskId);
    emit(cwd, makeEvent(TASK_EVIDENCE_RECORDED_EVENT, { taskId, evidence }));
    return getTaskOrThrow(cwd, taskId);
  },
};
