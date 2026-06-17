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
  applyPatch,
  applyTaskEventToMap,
  clone,
  compareTasks,
  createTask as createTaskState,
  evaluateClaim,
  makeEvidence,
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

// ---------------------------------------------------------------------------
// Pure helpers (no instance state)
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function makeEvent(customType: string, data: Record<string, unknown>): TaskEvent {
  return { type: "custom", customType, data: { version: TASK_EVENT_VERSION, ...data }, ts: now() };
}

function numericTaskId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
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

/**
 * Combine replace/add/remove dependency deltas into a final array. Returns
 * undefined when no dependency field was supplied, so the caller can skip the
 * field entirely (preserving the existing value instead of clobbering it).
 */
function resolveDependencyList(
  current: string[],
  replace: string[] | undefined,
  add: string[] | undefined,
  remove: string[] | undefined,
): string[] | undefined {
  if (replace === undefined && add === undefined && remove === undefined) return undefined;
  let next = replace !== undefined ? [...stringArray(replace)] : [...current];
  for (const id of stringArray(add)) {
    if (!next.includes(id)) next.push(id);
  }
  const removeSet = new Set(stringArray(remove));
  if (removeSet.size > 0) next = next.filter((id) => !removeSet.has(id));
  return next;
}

function applyUpdate(task: TaskItem, update: TaskUpdateInput): TaskItem {
  // Field normalization is delegated to applyPatch (single source of truth,
  // shared with the event-sourced projection). Only the add/remove dependency
  // delta logic is resolved here, then handed to applyPatch as a flat patch.
  const patch: TaskPatch = {
    title: update.title,
    prompt: update.prompt,
    status: update.status,
    kind: update.kind,
    activeForm: update.activeForm,
    agent: update.agent,
    owner: update.owner,
    source: update.source,
    cwd: update.cwd,
    acceptance: update.acceptance as TaskAcceptance | undefined,
    metadata: update.metadata,
    blockedBy: resolveDependencyList(task.blockedBy, update.blockedBy, update.addBlockedBy, update.removeBlockedBy),
    blocks: resolveDependencyList(task.blocks, update.blocks, update.addBlocks, update.removeBlocks),
  };
  return applyPatch(task, patch, now());
}

// ---------------------------------------------------------------------------
// TaskStore
//
// Session-backed projection cache + mutation API. State is instance-scoped
// (not module-global) so stores can be instantiated independently for tests or
// isolated runtimes; `taskStore` below is the process-wide default. The
// synchronous atomicity invariants on createTask/claimTask depend on NO await
// appearing between the precondition check and the emit — moving state from
// module globals into instance fields does not change that, because every
// helper here is still a plain synchronous call. Do not add awaits to the
// check-then-act paths.
// ---------------------------------------------------------------------------

export class TaskStore {
  private tasksByCwd = new Map<string, Map<string, TaskItem>>();
  private highWaterIdsByCwd = new Map<string, number>();
  private eventAppender: ((event: TaskEvent) => void) | undefined;
  private appendSuppressionDepth = 0;
  // Monotonic generation bumped on every mutation (emit) and full reproject
  // (applyEvents/reset). Used by the widget to skip re-cloning/re-sorting the
  // task array on idle animation frames when canonical state is unchanged.
  private storeVersion = 0;

  private getCwdMap(cwd: string): Map<string, TaskItem> {
    let map = this.tasksByCwd.get(cwd);
    if (!map) {
      map = new Map();
      this.tasksByCwd.set(cwd, map);
    }
    return map;
  }

  private appendEvent(event: TaskEvent): void {
    if (this.appendSuppressionDepth > 0) return;
    if (!this.eventAppender) throw new Error("Task session event appender is not configured.");
    this.eventAppender(event);
  }

  private updateHighWater(cwd: string, id: unknown): void {
    const n = numericTaskId(id);
    if (!n) return;
    this.highWaterIdsByCwd.set(cwd, Math.max(this.highWaterIdsByCwd.get(cwd) ?? 0, n));
  }

  private updateHighWaterFromEvent(cwd: string, event: TaskEvent): void {
    this.updateHighWater(cwd, String(highWaterFromEvent(event) ?? ""));
  }

  private currentHighWater(cwd: string): number {
    let max = this.highWaterIdsByCwd.get(cwd) ?? 0;
    for (const id of this.getCwdMap(cwd).keys()) {
      max = Math.max(max, numericTaskId(id) ?? 0);
    }
    this.highWaterIdsByCwd.set(cwd, max);
    return max;
  }

  private emit(cwd: string, event: TaskEvent): void {
    this.storeVersion += 1;
    const scopedEvent = { ...event, scope: cwd };
    this.appendEvent(scopedEvent);
    this.updateHighWaterFromEvent(cwd, scopedEvent);
    this.tasksByCwd.set(cwd, applyTaskEventToMap(this.getCwdMap(cwd), scopedEvent));
  }

  private nextId(cwd: string): string {
    return String(this.currentHighWater(cwd) + 1);
  }

  private getTaskOrThrow(cwd: string, taskId: string): TaskItem {
    const task = this.getCwdMap(cwd).get(taskId);
    if (!task) throw new Error(`Task #${taskId} not found.`);
    return clone(task);
  }

  private reciprocalUpdates(cwd: string, task: TaskItem, before?: TaskItem): TaskItem[] {
    const updates = new Map<string, TaskItem>();
    const map = this.getCwdMap(cwd);
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

  private emitTaskSnapshot(cwd: string, task: TaskItem): TaskItem {
    this.emit(cwd, makeEvent(TASK_UPDATED_EVENT, { taskId: task.id, task }));
    return this.getTaskOrThrow(cwd, task.id);
  }

  setEventAppender(appender: (event: TaskEvent) => void): void {
    this.eventAppender = appender;
  }

  reset(): void {
    this.tasksByCwd.clear();
    this.highWaterIdsByCwd.clear();
    this.eventAppender = undefined;
    this.appendSuppressionDepth = 0;
    this.storeVersion += 1;
  }

  /** Monotonic generation bumped on every task mutation or full reproject. */
  getVersion(): number {
    return this.storeVersion;
  }

  withoutAppending<T>(fn: () => T): T {
    this.appendSuppressionDepth += 1;
    try {
      return fn();
    } finally {
      this.appendSuppressionDepth -= 1;
    }
  }

  applyEvents(cwd: string, events: TaskEvent[]): void {
    let projected = new Map<string, TaskItem>();
    let highWater = 0;
    for (const event of events) {
      projected = applyTaskEventToMap(projected, event);
      highWater = Math.max(highWater, highWaterFromEvent(event) ?? 0);
    }
    this.tasksByCwd.set(cwd, projected);
    this.highWaterIdsByCwd.set(cwd, Math.max(highWater, ...Array.from(projected.keys(), (id) => numericTaskId(id) ?? 0)));
    this.storeVersion += 1;
  }

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
    const task = createTaskState(input, input.id ?? this.nextId(cwd));
    if (this.getCwdMap(cwd).has(task.id)) throw new Error(`Task #${task.id} already exists.`);
    this.emit(cwd, makeEvent(TASK_CREATED_EVENT, { taskId: task.id, task }));
    for (const other of this.reciprocalUpdates(cwd, task)) this.emitTaskSnapshot(cwd, other);
    return this.getTaskOrThrow(cwd, task.id);
  }

  readTask(cwd: string, taskId: string): TaskItem | null {
    const task = this.getCwdMap(cwd).get(taskId);
    return task ? clone(task) : null;
  }

  readAll(cwd: string): TaskItem[] {
    return Array.from(this.getCwdMap(cwd).values()).map(clone).sort(compareTasks);
  }

  ready(cwd: string): TaskItem[] {
    return readyTasks(this.getCwdMap(cwd).values()).map(clone);
  }

  updateTask(cwd: string, taskId: string, update: TaskUpdateInput): TaskItem {
    const before = this.getTaskOrThrow(cwd, taskId);
    const after = applyUpdate(before, update);
    this.emitTaskSnapshot(cwd, after);
    for (const other of this.reciprocalUpdates(cwd, after, before)) this.emitTaskSnapshot(cwd, other);
    return this.getTaskOrThrow(cwd, taskId);
  }

  updateStatus(cwd: string, taskId: string, status: TaskStatus, reason?: string): TaskItem {
    const current = this.getTaskOrThrow(cwd, taskId);
    const nextStatus = normalizeStatus(status, current.status);
    this.emit(cwd, makeEvent(TASK_STATUS_UPDATED_EVENT, { taskId, status: nextStatus, reason }));
    if (reason?.trim()) {
      this.emit(cwd, makeEvent(TASK_EVIDENCE_RECORDED_EVENT, { taskId, evidence: makeEvidence("note", reason.trim(), { source: TASK_STATUS_UPDATED_EVENT }) }));
    }
    return this.getTaskOrThrow(cwd, taskId);
  }

  /**
   * Atomicity invariant: evaluateClaim (precondition check) and the subsequent
   * emit are safe together only because this method is synchronous — the event
   * loop cannot interleave another claim between the check and the mutation.
   * If an `await` is inserted, re-evaluate: two callers could both pass the
   * check and both claim. claude-code guards this with a task-list file lock
   * because its store is cross-process; pi-tasks' in-memory event model does not.
   */
  claimTask(cwd: string, taskId: string, options: ClaimTaskOptions): ClaimTaskResult {
    const map = this.getCwdMap(cwd);
    const task = map.get(taskId) ?? null;
    const normalizedOptions = { ...options, owner: options.owner.trim() };
    const result = evaluateClaim(task, map.values(), normalizedOptions);
    if (!result.success || !result.task) return result;

    this.emitTaskSnapshot(cwd, applyUpdate(this.getTaskOrThrow(cwd, taskId), {
      owner: normalizedOptions.owner,
      ...(normalizedOptions.start ? { status: "in_progress" as TaskStatus } : {}),
    }));
    return { success: true, task: this.getTaskOrThrow(cwd, taskId) };
  }

  deleteTask(cwd: string, taskId: string): void {
    this.getTaskOrThrow(cwd, taskId);
    this.emit(cwd, makeEvent(TASK_DELETED_EVENT, { taskId }));
  }

  clearCompleted(cwd: string): number {
    const before = Array.from(this.getCwdMap(cwd).values()).filter((task) => task.status === "completed").length;
    this.emit(cwd, makeEvent(TASK_CLEARED_EVENT, { scope: "completed" }));
    return before;
  }

  clearAll(cwd: string): number {
    const before = this.getCwdMap(cwd).size;
    this.emit(cwd, makeEvent(TASK_CLEARED_EVENT, { scope: "all" }));
    return before;
  }

  snapshot(cwd: string): number {
    const tasks = Array.from(this.getCwdMap(cwd).values()).map(clone).sort(compareTasks);
    this.emit(cwd, makeEvent(TASK_SNAPSHOT_EVENT, { tasks, highWaterId: String(this.currentHighWater(cwd)) }));
    return tasks.length;
  }

  startRun(cwd: string, taskId: string, run: TaskRunRecord): TaskItem {
    this.getTaskOrThrow(cwd, taskId);
    this.emit(cwd, makeEvent(TASK_RUN_STARTED_EVENT, { taskId, run }));
    return this.getTaskOrThrow(cwd, taskId);
  }

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
    this.getTaskOrThrow(cwd, taskId);
    this.emit(cwd, makeEvent(TASK_RUN_FINISHED_EVENT, { taskId, status, ...opts }));
    return this.getTaskOrThrow(cwd, taskId);
  }

  /**
   * Atomically finish a run and record a status-appropriate evidence entry.
   * Centralizes the finishRun + recordEvidence pair and the run-status →
   * evidence-kind mapping (failed→error, cancelled→note, else→output) that
   * was duplicated across every TaskRun/TaskRetry/TaskOutput/async-complete
   * call site. Returns the latest task projection.
   */
  completeRun(
    cwd: string,
    taskId: string,
    status: TaskRunStatus,
    opts: {
      summary: string;
      error?: string;
      usage?: TaskRunRecord["usage"];
      subagent?: Partial<TaskSubagentRef>;
      evidenceMetadata?: Record<string, unknown>;
    },
  ): TaskItem {
    this.finishRun(cwd, taskId, status, {
      summary: opts.summary,
      output: opts.summary,
      error: opts.error,
      usage: opts.usage,
      subagent: opts.subagent,
    });
    const kind = status === "failed" ? "error" : status === "cancelled" ? "note" : "output";
    return this.recordEvidence(cwd, taskId, makeEvidence(kind, opts.summary, opts.evidenceMetadata));
  }

  recordEvidence(cwd: string, taskId: string, evidence: TaskEvidence): TaskItem {
    this.getTaskOrThrow(cwd, taskId);
    this.emit(cwd, makeEvent(TASK_EVIDENCE_RECORDED_EVENT, { taskId, evidence }));
    return this.getTaskOrThrow(cwd, taskId);
  }
}

/** Process-wide default store. Import this for normal use; use `new TaskStore()` or `createTaskStore()` for isolated instances (e.g. tests). */
export const taskStore: TaskStore = new TaskStore();

/** Construct an isolated TaskStore with its own projection cache and version counter. */
export function createTaskStore(): TaskStore {
  return new TaskStore();
}
