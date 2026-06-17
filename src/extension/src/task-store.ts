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
  clone,
  compareTasks,
  createTask as createTaskState,
  evaluateClaim,
  makeEvidence,
  mergeMetadata,
  normalizeKind,
  normalizeStatus,
  readyTasks,
  stringArray,
  type ClaimTaskOptions,
  type ClaimTaskReason,
  type ClaimTaskResult,
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
  ClaimTaskOptions,
  ClaimTaskReason,
  ClaimTaskResult,
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
const highWaterIdsByCwd = new Map<string, number>();
let eventAppender: ((event: TaskEvent) => void) | undefined;
let appendSuppressionDepth = 0;

// Monotonic generation bumped on every mutation (emit) and full reproject
// (applyEvents/reset). Used by the widget to skip re-cloning/re-sorting the
// task array on idle animation frames when canonical state is unchanged.
let storeVersion = 0;

function now(): string {
  return new Date().toISOString();
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

function numericTaskId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function updateHighWater(cwd: string, id: unknown): void {
  const n = numericTaskId(id);
  if (!n) return;
  highWaterIdsByCwd.set(cwd, Math.max(highWaterIdsByCwd.get(cwd) ?? 0, n));
}

function highWaterFromEvent(event: TaskEvent): number | undefined {
  const data = event.data ?? {};
  if (typeof data.version === "number" && data.version > TASK_EVENT_VERSION) return undefined;
  const ids: unknown[] = [data.highWaterId, data.taskId, (data.task as { id?: unknown } | undefined)?.id];
  if (Array.isArray(data.tasks)) {
    for (const task of data.tasks) ids.push((task as { id?: unknown } | undefined)?.id);
  }
  const numeric = ids.map(numericTaskId).filter((id): id is number => typeof id === "number");
  return numeric.length > 0 ? Math.max(...numeric) : undefined;
}

function updateHighWaterFromEvent(cwd: string, event: TaskEvent): void {
  updateHighWater(cwd, String(highWaterFromEvent(event) ?? ""));
}

function currentHighWater(cwd: string): number {
  let max = highWaterIdsByCwd.get(cwd) ?? 0;
  for (const id of getCwdMap(cwd).keys()) {
    max = Math.max(max, numericTaskId(id) ?? 0);
  }
  highWaterIdsByCwd.set(cwd, max);
  return max;
}

function emit(cwd: string, event: TaskEvent): void {
  storeVersion += 1;
  const scopedEvent = { ...event, scope: cwd };
  appendEvent(scopedEvent);
  updateHighWaterFromEvent(cwd, scopedEvent);
  tasksByCwd.set(cwd, applyTaskEventToMap(getCwdMap(cwd), scopedEvent));
}

function nextId(cwd: string): string {
  return String(currentHighWater(cwd) + 1);
}

function getTaskOrThrow(cwd: string, taskId: string): TaskItem {
  const task = getCwdMap(cwd).get(taskId);
  if (!task) throw new Error(`Task #${taskId} not found.`);
  return clone(task);
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
    highWaterIdsByCwd.clear();
    eventAppender = undefined;
    appendSuppressionDepth = 0;
    storeVersion += 1;
  },

  /** Monotonic generation bumped on every task mutation or full reproject. */
  getVersion(): number {
    return storeVersion;
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
    let highWater = 0;
    for (const event of events) {
      projected = applyTaskEventToMap(projected, event);
      highWater = Math.max(highWater, highWaterFromEvent(event) ?? 0);
    }
    tasksByCwd.set(cwd, projected);
    highWaterIdsByCwd.set(cwd, Math.max(highWater, ...Array.from(projected.keys(), (id) => numericTaskId(id) ?? 0)));
    storeVersion += 1;
  },

  /**
   * Atomicity invariant: the nextId → existence-check → emit sequence is safe
   * only because this method is fully synchronous. Node's single-threaded event
   * loop guarantees no other caller can interleave between reading the high
   * water mark and appending the TASK_CREATED event. If any `await` is ever
   * added to this path, the check-then-act becomes a TOCTOU race and a lock or
   * compare-and-set on storeVersion is required (claude-code needed proper-lockfile
   * for exactly this reason in its multi-process file store).
   */
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

  /**
   * Atomicity invariant: evaluateClaim (precondition check) and the subsequent
   * emit are safe together only because this method is synchronous — the event
   * loop cannot interleave another claim between the check and the mutation.
   * If an `await` is inserted, re-evaluate: two callers could both pass the
   * check and both claim. claude-code guards this with a task-list file lock
   * because its store is cross-process; pi-tasks' in-memory event model does not.
   */
  claimTask(cwd: string, taskId: string, options: ClaimTaskOptions): ClaimTaskResult {
    const map = getCwdMap(cwd);
    const task = map.get(taskId) ?? null;
    const normalizedOptions = { ...options, owner: options.owner.trim() };
    const result = evaluateClaim(task, map.values(), normalizedOptions);
    if (!result.success || !result.task) return result;

    emitTaskSnapshot(cwd, applyUpdate(getTaskOrThrow(cwd, taskId), {
      owner: normalizedOptions.owner,
      ...(normalizedOptions.start ? { status: "in_progress" as TaskStatus } : {}),
    }));
    return { success: true, task: getTaskOrThrow(cwd, taskId) };
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
    emit(cwd, makeEvent(TASK_SNAPSHOT_EVENT, { tasks, highWaterId: String(currentHighWater(cwd)) }));
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
