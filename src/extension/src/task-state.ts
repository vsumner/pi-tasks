// ---------------------------------------------------------------------------
// pi-tasks canonical state model
//
// State is an event-sourced projection over Pi session entries. This file is
// pure: no ExtensionAPI, no filesystem, no pi-subagents calls.
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

export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
export type TaskKind = "manual" | "subagent" | "packet";
export type TaskRunStatus = "queued" | "running" | "detached" | "completed" | "failed" | "cancelled";
export type TaskSource = "user" | "agent" | "pi-goals" | "import" | string;

export type TaskAcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified" | "reviewed";

export interface TaskAcceptanceConfig {
  level?: TaskAcceptanceLevel;
  criteria?: Array<string | Record<string, unknown>>;
  evidence?: string[];
  verify?: Array<Record<string, unknown>>;
  review?: false | Record<string, unknown>;
  stopRules?: string[];
  reason?: string;
  [key: string]: unknown;
}

export type TaskAcceptance = false | TaskAcceptanceLevel | TaskAcceptanceConfig;

export interface TaskSubagentRef {
  requestId?: string;
  runId?: string;
  asyncId?: string;
  asyncDir?: string;
  agent?: string;
  sessionFiles: string[];
  savedOutputs: string[];
  artifactOutputs: string[];
}

export interface TaskEvidence {
  id: string;
  kind: "note" | "proof" | "review" | "output" | "error";
  text: string;
  passed?: boolean;
  command?: string;
  ts: string;
  metadata?: Record<string, unknown>;
}

export interface TaskRunRecord {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  agent: string;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  output?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    turns?: number;
    cost?: number;
  };
  subagent: TaskSubagentRef;
}

/**
 * Ephemeral live-activity snapshot for an in_progress task run, fed by the
 * pi-subagents update channel (subagent:slash:update). This is runtime display
 * state only — it is never appended to session events (doing so would flood
 * the session and re-trigger compaction churn). Mirrors claude-src's
 * per-teammate recentActivities rollup line.
 */
export interface TaskActivity {
  tool?: string;
  count: number;
  ts: number;
}

/** Handler that records live activity for a task. Scope is the task-store key (session id or cwd). */
export type TaskActivityHandler = (scope: string, taskId: string, activity: TaskActivity) => void;

export interface TaskItem {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  kind: TaskKind;
  activeForm?: string;
  agent?: string;
  owner?: string;
  source: TaskSource;
  cwd?: string;
  blockedBy: string[];
  blocks: string[];
  acceptance?: TaskAcceptance;
  metadata: Record<string, unknown>;
  evidence: TaskEvidence[];
  run?: TaskRunRecord;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
  ts?: string;
  /** In-memory owner key used by the extension appender; not persisted in Pi entries. */
  scope?: string;
}

export type TaskPatch = Partial<Pick<
  TaskItem,
  | "title"
  | "prompt"
  | "status"
  | "kind"
  | "activeForm"
  | "agent"
  | "owner"
  | "source"
  | "cwd"
  | "blockedBy"
  | "blocks"
  | "acceptance"
  | "metadata"
>>;

export interface TaskCreateInput {
  id?: string;
  title: string;
  prompt: string;
  kind?: TaskKind;
  activeForm?: string;
  agent?: string;
  owner?: string;
  source?: TaskSource;
  cwd?: string;
  blockedBy?: string[];
  blocks?: string[];
  acceptance?: TaskAcceptance;
  metadata?: Record<string, unknown>;
}

function now(): string {
  return new Date().toISOString();
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0)));
}

export function mergeMetadata(current: Record<string, unknown>, patch: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!patch) return { ...current };
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function normalizeStatus(value: unknown, fallback: TaskStatus = "pending"): TaskStatus {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return fallback;
}

export function normalizeKind(value: unknown, fallback: TaskKind = "subagent"): TaskKind {
  if (value === "manual" || value === "subagent" || value === "packet") return value;
  return fallback;
}

function normalizeRunStatus(value: unknown, fallback?: TaskRunStatus): TaskRunStatus | undefined {
  if (
    value === "queued" ||
    value === "running" ||
    value === "detached" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  if (value === undefined) return fallback;
  return "failed";
}

function runStatusToTaskStatus(status: TaskRunStatus): TaskStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "in_progress";
}

export function createTask(input: TaskCreateInput, id: string): TaskItem {
  const ts = now();
  return {
    id,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    status: "pending",
    kind: input.kind ?? "subagent",
    activeForm: input.activeForm?.trim() || undefined,
    agent: input.agent?.trim() || undefined,
    owner: input.owner?.trim() || undefined,
    source: input.source ?? "agent",
    cwd: input.cwd,
    blockedBy: stringArray(input.blockedBy),
    blocks: stringArray(input.blocks),
    acceptance: input.acceptance,
    metadata: input.metadata ?? {},
    evidence: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

export function isTaskBlocked(task: TaskItem, tasks: Iterable<TaskItem>): boolean {
  if (task.status !== "pending") return true;
  if (task.blockedBy.length === 0) return false;
  const byId = new Map(Array.from(tasks, (t) => [t.id, t] as const));
  return task.blockedBy.some((id) => byId.get(id)?.status !== "completed");
}

export function readyTasks(tasks: Iterable<TaskItem>): TaskItem[] {
  const all = Array.from(tasks);
  return all
    .filter((task) => !isTaskBlocked(task, all))
    .sort(compareTasks);
}

export function compareTasks(a: TaskItem, b: TaskItem): number {
  const numeric = Number(a.id) - Number(b.id);
  if (Number.isFinite(numeric) && numeric !== 0) return numeric;
  return a.id.localeCompare(b.id);
}

/**
 * True for bookkeeping tasks hidden from model-facing list/status output and
 * the task widget. Set via `metadata._internal` (truthy) when an extension or
 * pi-goals creates scaffolding work the model and user should not see. Mirrors
 * claude-code's `metadata._internal` filter in TaskListTool/useTasksV2.
 * Canonical state is unaffected — TaskGet/TaskRun still see internal tasks by id.
 */
export function isInternal(task: TaskItem): boolean {
  return Boolean(task.metadata?._internal);
}

/** Tasks visible to the model in list/status output and the widget. */
export function filterVisible(tasks: Iterable<TaskItem>): TaskItem[] {
  return Array.from(tasks).filter((task) => !isInternal(task));
}

function applyPatch(task: TaskItem, patch: TaskPatch, ts: string): TaskItem {
  const next = clone(task);
  if (typeof patch.title === "string") next.title = patch.title.trim();
  if (typeof patch.prompt === "string") next.prompt = patch.prompt.trim();
  if (patch.status !== undefined) next.status = normalizeStatus(patch.status, next.status);
  if (patch.kind !== undefined) next.kind = normalizeKind(patch.kind);
  if (patch.activeForm !== undefined) next.activeForm = patch.activeForm?.trim() || undefined;
  if (patch.agent !== undefined) next.agent = patch.agent?.trim() || undefined;
  if (patch.owner !== undefined) next.owner = patch.owner?.trim() || undefined;
  if (patch.source !== undefined) next.source = String(patch.source || "agent");
  if (patch.cwd !== undefined) next.cwd = patch.cwd;
  if (patch.blockedBy !== undefined) next.blockedBy = stringArray(patch.blockedBy);
  if (patch.blocks !== undefined) next.blocks = stringArray(patch.blocks);
  if (patch.acceptance !== undefined) next.acceptance = patch.acceptance;
  if (patch.metadata !== undefined) next.metadata = mergeMetadata(next.metadata, patch.metadata);
  next.updatedAt = ts;
  return next;
}

function upsertTask(tasks: Map<string, TaskItem>, task: TaskItem): void {
  tasks.set(task.id, clone(task));
}

function mergeSubagentRef(current: TaskSubagentRef, patch: unknown): TaskSubagentRef {
  const raw = typeof patch === "object" && patch !== null ? patch as Partial<TaskSubagentRef> : {};
  const next = clone(current);
  if (typeof raw.requestId === "string" && raw.requestId.length > 0) next.requestId = raw.requestId;
  if (typeof raw.runId === "string" && raw.runId.length > 0) next.runId = raw.runId;
  if (typeof raw.asyncId === "string" && raw.asyncId.length > 0) next.asyncId = raw.asyncId;
  if (typeof raw.asyncDir === "string" && raw.asyncDir.length > 0) next.asyncDir = raw.asyncDir;
  if (typeof raw.agent === "string" && raw.agent.length > 0) next.agent = raw.agent;
  next.sessionFiles = stringArray([...next.sessionFiles, ...stringArray(raw.sessionFiles)]);
  next.savedOutputs = stringArray([...next.savedOutputs, ...stringArray(raw.savedOutputs)]);
  next.artifactOutputs = stringArray([...next.artifactOutputs, ...stringArray(raw.artifactOutputs)]);
  return next;
}

function supportedEventVersion(data: Record<string, unknown>): boolean {
  const raw = data.version;
  return typeof raw !== "number" || raw <= TASK_EVENT_VERSION;
}

export function applyTaskEventToMap(current: Map<string, TaskItem>, event: TaskEvent): Map<string, TaskItem> {
  const tasks = new Map(Array.from(current.entries(), ([id, task]) => [id, clone(task)] as const));
  const customType = event.customType ?? event.type;
  const data = event.data ?? {};
  const ts = event.ts ?? now();
  if (!supportedEventVersion(data)) return tasks;

  switch (customType) {
    case TASK_SNAPSHOT_EVENT: {
      const snapshot = Array.isArray(data.tasks) ? data.tasks as TaskItem[] : [];
      const next = new Map<string, TaskItem>();
      for (const task of snapshot) {
        if (task && typeof task.id === "string") upsertTask(next, task);
      }
      return next;
    }

    case TASK_CREATED_EVENT: {
      const task = data.task as TaskItem | undefined;
      if (task && typeof task.id === "string") upsertTask(tasks, { ...task, updatedAt: task.updatedAt ?? ts });
      return tasks;
    }

    case TASK_UPDATED_EVENT: {
      const task = data.task as TaskItem | undefined;
      if (task && typeof task.id === "string") {
        if (!tasks.has(task.id)) return tasks;
        upsertTask(tasks, { ...task, updatedAt: ts });
        return tasks;
      }
      const taskId = String(data.taskId ?? "");
      const currentTask = tasks.get(taskId);
      if (!currentTask) return tasks;
      upsertTask(tasks, applyPatch(currentTask, (data.patch ?? {}) as TaskPatch, ts));
      return tasks;
    }

    case TASK_STATUS_UPDATED_EVENT: {
      const taskId = String(data.taskId ?? "");
      const currentTask = tasks.get(taskId);
      if (!currentTask) return tasks;
      const next = applyPatch(currentTask, { status: normalizeStatus(data.status, currentTask.status) }, ts);
      upsertTask(tasks, next);
      return tasks;
    }

    case TASK_RUN_STARTED_EVENT: {
      const taskId = String(data.taskId ?? "");
      const currentTask = tasks.get(taskId);
      const run = data.run as TaskRunRecord | undefined;
      if (!currentTask || !run) return tasks;
      const next = clone(currentTask);
      next.status = "in_progress";
      next.owner = run.subagent.runId ?? run.subagent.asyncId ?? run.subagent.requestId ?? run.id;
      next.run = clone(run);
      next.updatedAt = ts;
      upsertTask(tasks, next);
      return tasks;
    }

    case TASK_RUN_FINISHED_EVENT: {
      const taskId = String(data.taskId ?? "");
      const currentTask = tasks.get(taskId);
      if (!currentTask) return tasks;
      const currentRun = currentTask.run;
      const runStatus = normalizeRunStatus(data.status, currentRun?.status);
      if (!runStatus) return tasks;
      const rawSubagent = typeof data.subagent === "object" && data.subagent !== null ? data.subagent as Partial<TaskSubagentRef> : undefined;
      const fallbackAgent = typeof rawSubagent?.agent === "string" && rawSubagent.agent.length > 0 ? rawSubagent.agent : "unknown";
      const baseRun: TaskRunRecord = currentRun ?? {
        id: typeof data.runId === "string" && data.runId.length > 0 ? data.runId : `orphan-${taskId}`,
        taskId,
        status: runStatus,
        agent: fallbackAgent,
        startedAt: ts,
        subagent: {
          agent: fallbackAgent,
          sessionFiles: [],
          savedOutputs: [],
          artifactOutputs: [],
        },
      };
      const next = clone(currentTask);
      next.run = {
        ...baseRun,
        status: runStatus,
        finishedAt: ts,
        summary: typeof data.summary === "string" ? data.summary : baseRun.summary,
        error: typeof data.error === "string" ? data.error : baseRun.error,
        output: typeof data.output === "string" ? data.output : baseRun.output,
        usage: typeof data.usage === "object" && data.usage !== null ? data.usage as TaskRunRecord["usage"] : baseRun.usage,
        subagent: mergeSubagentRef(baseRun.subagent, data.subagent),
      };
      next.status = runStatusToTaskStatus(runStatus);
      next.updatedAt = ts;
      upsertTask(tasks, next);
      return tasks;
    }

    case TASK_EVIDENCE_RECORDED_EVENT: {
      const taskId = String(data.taskId ?? "");
      const currentTask = tasks.get(taskId);
      const evidence = data.evidence as TaskEvidence | undefined;
      if (!currentTask || !evidence) return tasks;
      const next = clone(currentTask);
      const normalized = { ...evidence, ts: evidence.ts ?? ts };
      const existingIndex = next.evidence.findIndex((item) => item.id === normalized.id);
      if (existingIndex >= 0) next.evidence[existingIndex] = normalized;
      else next.evidence.push(normalized);
      next.updatedAt = ts;
      upsertTask(tasks, next);
      return tasks;
    }

    case TASK_DELETED_EVENT: {
      const taskId = String(data.taskId ?? "");
      tasks.delete(taskId);
      for (const task of tasks.values()) {
        task.blocks = task.blocks.filter((id) => id !== taskId);
        task.blockedBy = task.blockedBy.filter((id) => id !== taskId);
        task.updatedAt = ts;
      }
      return tasks;
    }

    case TASK_CLEARED_EVENT: {
      const scope = data.scope === "all" ? "all" : "completed";
      if (scope === "all") {
        tasks.clear();
        return tasks;
      }
      const deleted = new Set<string>();
      for (const [id, task] of tasks) {
        if (task.status === "completed") {
          deleted.add(id);
          tasks.delete(id);
        }
      }
      if (deleted.size > 0) {
        for (const task of tasks.values()) {
          task.blocks = task.blocks.filter((id) => !deleted.has(id));
          task.blockedBy = task.blockedBy.filter((id) => !deleted.has(id));
          task.updatedAt = ts;
        }
      }
      return tasks;
    }

    default:
      return tasks;
  }
}

export function projectTasksFromEvents(events: TaskEvent[]): TaskItem[] {
  let tasks = new Map<string, TaskItem>();
  for (const event of events) tasks = applyTaskEventToMap(tasks, event);
  return Array.from(tasks.values()).sort(compareTasks);
}

export function makeEvidence(
  kind: TaskEvidence["kind"],
  text: string,
  metadata?: Record<string, unknown>,
): TaskEvidence {
  return {
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text,
    ts: now(),
    metadata,
  };
}

export function summarizeTask(task: TaskItem): string {
  const blockerText = task.blockedBy.length > 0 ? ` blocked by ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const ownerText = task.owner ? ` owner=${task.owner}` : "";
  return `#${task.id} [${task.status}] ${task.title}${blockerText}${ownerText}`;
}

// ---------------------------------------------------------------------------
// Safe task owner claim
//
// Inspired by Claude's claimTask but without file persistence. The pure
// evaluateClaim helper checks preconditions; taskStore.claimTask applies the
// mutation when the check passes.
// ---------------------------------------------------------------------------

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export type ClaimTaskReason =
  | "task_not_found"
  | "invalid_owner"
  | "already_claimed"
  | "already_terminal"
  | "blocked"
  | "owner_busy";

export interface ClaimTaskOptions {
  owner: string;
  /** Also set status=in_progress when the claim succeeds. */
  start?: boolean;
  /** Override the already_claimed and owner_busy constraints. Does not bypass terminal or blocked checks. */
  force?: boolean;
  /** When true, refuse if the owner already owns another non-terminal task. */
  oneOpenPerOwner?: boolean;
}

export interface ClaimTaskResult {
  success: boolean;
  reason?: ClaimTaskReason;
  task?: TaskItem;
  /** Blocking dependency ids (present when reason is "blocked"). */
  blockedByTasks?: string[];
  /** Other open task ids the owner already holds (present when reason is "owner_busy"). */
  busyWithTasks?: string[];
}

/**
 * Pure precondition check for a safe owner claim. Returns a structured result
 * describing why the claim would fail, or { success: true, task } when the task
 * is claimable. Does not mutate.
 */
export function evaluateClaim(
  task: TaskItem | null | undefined,
  tasks: Iterable<TaskItem>,
  options: ClaimTaskOptions,
): ClaimTaskResult {
  if (!task) return { success: false, reason: "task_not_found" };

  const owner = options.owner.trim();
  if (!owner) return { success: false, reason: "invalid_owner", task };

  if (isTerminalStatus(task.status)) return { success: false, reason: "already_terminal", task };

  if (task.owner && task.owner !== owner && !options.force) {
    return { success: false, reason: "already_claimed", task };
  }

  const all = Array.from(tasks);
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const blockedByTasks = task.blockedBy.filter((id) => byId.get(id)?.status !== "completed");
  if (blockedByTasks.length > 0) {
    return { success: false, reason: "blocked", task, blockedByTasks };
  }

  if (options.oneOpenPerOwner && !options.force) {
    const busyWithTasks = all
      .filter((t) => t.id !== task.id && t.owner === owner && !isTerminalStatus(t.status))
      .map((t) => t.id);
    if (busyWithTasks.length > 0) {
      return { success: false, reason: "owner_busy", task, busyWithTasks };
    }
  }

  return { success: true, task };
}
