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

const ACCEPTANCE_LEVELS: readonly TaskAcceptanceLevel[] = ["auto", "none", "attested", "checked", "verified", "reviewed"];

/** Human-readable shape reference included in validation errors so the model can self-correct in one turn. */
export const ACCEPTANCE_SCHEMA_HINT =
  "acceptance may be: false | one of [auto|none|attested|checked|verified|reviewed] | an object " +
  "{ level?, criteria?: Array<string|{id,must,severity?}>, evidence?: string[], " +
  "verify?: Array<{id:string, command:string, timeoutMs?, cwd?, env?, allowFailure?}>, " +
  "review?: false|{agent?,required?,focus?}, stopRules?: string[], reason?: string }";

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Validate the structural shape of an acceptance policy. Returns a list of
 * human-readable error strings (empty when valid). Catches malformed configs
 * at create/update time instead of letting them fail opaquely at TaskRun.
 * Mirrors claude-code 2.1.169 ("validation errors include the schema").
 *
 * Note: this validates shape only. The `agent` task field is intentionally NOT
 * checked against a registry here — pi-subagents exposes no agent-list API to
 * extensions, and a hard check would wrongly reject valid packaged/project
 * agents that this package cannot enumerate.
 */
export function validateAcceptance(acceptance: unknown): string[] {
  const errors: string[] = [];
  if (acceptance === undefined || acceptance === null || acceptance === false) return errors;

  if (typeof acceptance === "string") {
    if (!ACCEPTANCE_LEVELS.includes(acceptance as TaskAcceptanceLevel)) {
      errors.push(`level "${acceptance}" is not one of: ${ACCEPTANCE_LEVELS.join(", ")}`);
    }
    return errors;
  }

  if (typeof acceptance !== "object" || Array.isArray(acceptance)) {
    errors.push(`must be false, a level string, or an object (got ${Array.isArray(acceptance) ? "array" : typeof acceptance})`);
    return errors;
  }

  const cfg = acceptance as Record<string, unknown>;

  if (cfg.level !== undefined && (typeof cfg.level !== "string" || !ACCEPTANCE_LEVELS.includes(cfg.level as TaskAcceptanceLevel))) {
    errors.push(`level must be one of: ${ACCEPTANCE_LEVELS.join(", ")} (got ${JSON.stringify(cfg.level)})`);
  }

  if (cfg.criteria !== undefined) {
    if (!Array.isArray(cfg.criteria)) {
      errors.push(`criteria must be an array (got ${typeof cfg.criteria})`);
    } else {
      cfg.criteria.forEach((entry, i) => {
        if (typeof entry !== "string" && (typeof entry !== "object" || entry === null || Array.isArray(entry))) {
          errors.push(`criteria[${i}] must be a string or an object (got ${typeof entry})`);
        }
      });
    }
  }

  if (cfg.evidence !== undefined && !isStringArray(cfg.evidence)) {
    errors.push("evidence must be an array of strings");
  }

  if (cfg.verify !== undefined) {
    if (!Array.isArray(cfg.verify)) {
      errors.push("verify must be an array of {id, command} objects");
    } else {
      cfg.verify.forEach((entry, i) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          errors.push(`verify[${i}] must be an object with string id and command`);
          return;
        }
        const v = entry as Record<string, unknown>;
        if (typeof v.id !== "string" || v.id.length === 0) errors.push(`verify[${i}].id must be a non-empty string`);
        if (typeof v.command !== "string" || v.command.length === 0) errors.push(`verify[${i}].command must be a non-empty string`);
      });
    }
  }

  if (cfg.review !== undefined && cfg.review !== false && (typeof cfg.review !== "object" || Array.isArray(cfg.review))) {
    errors.push("review must be false or an object");
  }

  if (cfg.stopRules !== undefined && !isStringArray(cfg.stopRules)) {
    errors.push("stopRules must be an array of strings");
  }

  if (cfg.reason !== undefined && typeof cfg.reason !== "string") {
    errors.push("reason must be a string");
  }

  return errors;
}

/** Build a schema-rich error for invalid acceptance configs. */
export function acceptanceValidationError(errors: string[]): Error {
  return new Error(`Invalid acceptance policy:\n- ${errors.join("\n- ")}\n\nExpected shape: ${ACCEPTANCE_SCHEMA_HINT}`);
}

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

/**
 * Core readiness check against a prebuilt id→task index. O(task.blockedBy)
 * per call — it never scans or rebuilds the full collection. Pass a single
 * indexById() result when checking readiness for many tasks (the 150ms widget
 * repaint, the parallel-run readiness loop, readyTasksWithIndex). This is the
 * O(1)-index fix for the prior O(n²) path where readyTasks/isTaskBlocked each
 * rebuilt the full id index once per candidate task.
 */
export function isTaskBlockedById(task: TaskItem, byId: Map<string, TaskItem>): boolean {
  if (task.status !== "pending") return true;
  if (task.blockedBy.length === 0) return false;
  return task.blockedBy.some((id) => byId.get(id)?.status !== "completed");
}

/** Convenience wrapper that builds the index for a single readiness check. */
export function isTaskBlocked(task: TaskItem, tasks: Iterable<TaskItem>): boolean {
  return isTaskBlockedById(task, indexById(tasks));
}

/** Ready tasks against a prebuilt index — one filter pass, no per-task reindex. */
export function readyTasksWithIndex(tasks: TaskItem[], byId: Map<string, TaskItem>): TaskItem[] {
  return tasks.filter((task) => !isTaskBlockedById(task, byId)).sort(compareTasks);
}

export function readyTasks(tasks: Iterable<TaskItem>): TaskItem[] {
  const all = Array.from(tasks);
  return readyTasksWithIndex(all, indexById(all));
}

/** Unresolved blocker ids for a task against a prebuilt index (canonical helper). */
export function unresolvedBlockersById(task: TaskItem, byId: Map<string, TaskItem>): string[] {
  return task.blockedBy.filter((id) => byId.get(id)?.status !== "completed");
}

/** Unresolved blocker ids, building the index once from the full task set. */
export function unresolvedBlockers(task: TaskItem, allTasks?: TaskItem[] | Iterable<TaskItem>): string[] {
  if (!allTasks) return [...task.blockedBy];
  return unresolvedBlockersById(task, indexById(allTasks));
}

/**
 * Dependency ids that reference no known task. Used at write time (create /
 * update) to reject dangling blockedBy/blocks references early: a dependency
 * on a non-existent task is almost always a typo or a forward reference to a
 * not-yet-created id, and silently accepting it strands the task —
 * isTaskBlockedById treats a missing blocker as permanently unresolved.
 * Returns ids in first-seen order, deduped.
 */
export function unknownDependencyIds(ids: Iterable<string>, knownIds: Iterable<string>): string[] {
  const known = new Set(knownIds);
  return Array.from(new Set(ids)).filter((id) => !known.has(id));
}

export function compareTasks(a: TaskItem, b: TaskItem): number {
  const numeric = Number(a.id) - Number(b.id);
  if (Number.isFinite(numeric) && numeric !== 0) return numeric;
  return a.id.localeCompare(b.id);
}

/** Index a task collection by id. Shared by blocker resolution, claim checks, and rendering. */
export function indexById<T extends { id: string }>(tasks: Iterable<T>): Map<string, T> {
  return new Map(Array.from(tasks, (t) => [t.id, t] as const));
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

export function applyPatch(task: TaskItem, patch: TaskPatch, ts: string): TaskItem {
  const next = clone(task);
  if (typeof patch.title === "string") next.title = patch.title.trim();
  if (typeof patch.prompt === "string") next.prompt = patch.prompt.trim();
  if (patch.status !== undefined) next.status = normalizeStatus(patch.status, next.status);
  if (patch.kind !== undefined) next.kind = normalizeKind(patch.kind, next.kind);
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
  // Structural sharing: copy the map shallowly (reference entries only) and
  // clone just the task(s) an event touches. The upsert branches below all go
  // through upsertTask()/applyPatch(), which return fresh clones, so they
  // never mutate an entry shared with the prior map in place. DELETED and
  // CLEARED are the only branches that rewrite dependency arrays, so they
  // clone only the affected tasks rather than the whole map. This keeps a
  // single event O(affected) instead of O(n) deep-clones, and is safe because
  // every read path (readAll/readTask) already returns defensive clones — no
  // caller holds a live reference into this projection map.
  const tasks = new Map(current);
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
      // Only tasks that referenced the deleted id need a fresh copy; untouched
      // entries stay shared with the prior map.
      for (const [otherId, task] of tasks) {
        if (!task.blocks.includes(taskId) && !task.blockedBy.includes(taskId)) continue;
        const next = clone(task);
        next.blocks = next.blocks.filter((id) => id !== taskId);
        next.blockedBy = next.blockedBy.filter((id) => id !== taskId);
        next.updatedAt = ts;
        tasks.set(otherId, next);
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
        for (const [otherId, task] of tasks) {
          if (!task.blocks.some((b) => deleted.has(b)) && !task.blockedBy.some((b) => deleted.has(b))) continue;
          const next = clone(task);
          next.blocks = next.blocks.filter((id) => !deleted.has(id));
          next.blockedBy = next.blockedBy.filter((id) => !deleted.has(id));
          next.updatedAt = ts;
          tasks.set(otherId, next);
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
  const byId = indexById(all);
  const blockedByTasks = unresolvedBlockersById(task, byId);
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
