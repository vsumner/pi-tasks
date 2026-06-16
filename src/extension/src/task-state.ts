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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0)));
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

function normalizeStatus(value: unknown, fallback: TaskStatus = "pending"): TaskStatus {
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

function normalizeKind(value: unknown): TaskKind {
  if (value === "manual" || value === "subagent" || value === "packet") return value;
  return "subagent";
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
