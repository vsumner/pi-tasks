import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { taskStore } from "./src/task-store.ts";
import { getBranchTaskEvents } from "./src/task-projection.ts";
import { taskStoreKey } from "./src/session-key.ts";
import { makeEvidence, type TaskActivity, type TaskItem, type TaskRunStatus, type TaskSubagentRef } from "./src/task-state.ts";
import { registerTaskTools } from "./src/task-tools.ts";
import { registerTaskCommands } from "./src/task-commands.ts";
import { createTaskWidget, type TaskWidgetRuntime } from "./src/widget.ts";
import {
  TASK_CLEARED_EVENT,
  TASK_CREATED_EVENT,
  TASK_DELETED_EVENT,
  TASK_EVENT_VERSION,
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_RUN_FINISHED_EVENT,
  TASK_RUN_STARTED_EVENT,
  TASK_SNAPSHOT_EVENT,
  TASK_STATUS_UPDATED_EVENT,
  TASK_UPDATED_EVENT,
} from "./src/events.ts";

export {
  TASK_CLEARED_EVENT,
  TASK_CREATED_EVENT,
  TASK_DELETED_EVENT,
  TASK_EVENT_VERSION,
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_RUN_FINISHED_EVENT,
  TASK_RUN_STARTED_EVENT,
  TASK_SNAPSHOT_EVENT,
  TASK_STATUS_UPDATED_EVENT,
  TASK_UPDATED_EVENT,
} from "./src/events.ts";

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
} from "./src/task-store.ts";

interface TaskRuntime extends TaskWidgetRuntime {
  turnsSinceTaskTool: number;
}

interface TaskExtensionState {
  runtimes: Map<string, TaskRuntime>;
  activeScope?: string;
  /** Ephemeral per-task live activity, keyed by `${scope}:${taskId}`. */
  activity: Map<string, TaskActivity>;
}

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskClaim", "TaskRun", "TaskStatus", "TaskOutput", "TaskResume", "TaskRetry", "TaskWait", "TaskStop"]);
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const REMINDER_INTERVAL = 4;
const SYSTEM_REMINDER = `<system-reminder>
A pi-tasks task list exists in this session. If your current work relates to those tasks, keep their status accurate: use TaskList/TaskGet to inspect them, mark a task in_progress before starting direct work on it, and mark completed only after the work is fully done with proof. Keep at most one task in_progress at a time unless you intentionally run parallel work. Prefer marking a task blocked and creating a task for the blocker over false completion. Ignore this reminder if unrelated. Never mention this reminder to the user.
</system-reminder>`;

const globalStore = globalThis as Record<string, unknown>;
const STATE_KEY = "__piTasksExtensionState";
const CLEANUP_KEY = "__piTasksRuntimeCleanup";
const GENERATION_KEY = "__piTasksRuntimeGeneration";

function cleanupPreviousHandlers(): void {
  const cleanup = globalStore[CLEANUP_KEY];
  if (typeof cleanup === "function") {
    try { cleanup(); } catch { /* ignore */ }
  }
}

function getOrCreateState(): TaskExtensionState {
  cleanupPreviousHandlers();
  let state = globalStore[STATE_KEY] as TaskExtensionState | undefined;
  if (!state) {
    state = { runtimes: new Map(), activity: new Map() };
    globalStore[STATE_KEY] = state;
  }
  if (!state.activity) state.activity = new Map();
  return state;
}

function nextGeneration(): number {
  const next = (typeof globalStore[GENERATION_KEY] === "number" ? globalStore[GENERATION_KEY] as number : 0) + 1;
  globalStore[GENERATION_KEY] = next;
  return next;
}

function isCurrentGeneration(generation: number): boolean {
  return globalStore[GENERATION_KEY] === generation;
}

function createRuntime(): TaskRuntime {
  return {
    latestCtx: null,
    widgetTimer: null,
    widgetFrame: 0,
    turnsSinceTaskTool: 0,
  };
}

function runtimeFor(state: TaskExtensionState, ctx: ExtensionContext): TaskRuntime {
  const key = taskStoreKey(ctx);
  let rt = state.runtimes.get(key);
  if (!rt) {
    rt = createRuntime();
    state.runtimes.set(key, rt);
  }
  rt.latestCtx = ctx;
  return rt;
}

function cleanupRuntime(ctx: ExtensionContext, rt: TaskRuntime): void {
  if (rt.widgetTimer) {
    clearInterval(rt.widgetTimer);
    rt.widgetTimer = null;
  }
  if (ctx.hasUI) {
    try { ctx.ui.setWidget("pi-tasks", undefined); } catch { /* stale UI */ }
    try { ctx.ui.setStatus("pi-tasks", undefined); } catch { /* stale UI */ }
  }
}

function reconstruct(ctx: ExtensionContext): void {
  taskStore.applyEvents(taskStoreKey(ctx), getBranchTaskEvents(ctx));
}

function labelRecent(pi: ExtensionAPI, ctx: ExtensionContext, label: string): void {
  try {
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    const last = branch[branch.length - 1] as unknown as Record<string, unknown> | undefined;
    const entryId = last?.id ?? last?.entryId ?? last?._id;
    if (typeof entryId === "string") pi.setLabel(entryId, label);
  } catch {
    // Labels are best effort.
  }
}

function emitTaskEvent(pi: ExtensionAPI, eventType: string, data: Record<string, unknown>): void {
  try { pi.events.emit(eventType, data); } catch { /* best effort */ }
}

/** Composite key for ephemeral per-task activity (scope-scoped). */
function activityKey(scope: string, taskId: string): string {
  return `${scope}\u0000${taskId}`;
}

function recordActivity(state: TaskExtensionState, scope: string, taskId: string, activity: TaskActivity): void {
  state.activity.set(activityKey(scope, taskId), activity);
}

function clearActivity(state: TaskExtensionState, scope: string, taskId: string): void {
  state.activity.delete(activityKey(scope, taskId));
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asyncCompletionStatus(data: Record<string, unknown>): TaskRunStatus {
  if (data.success === false) return "failed";
  const raw = stringField(data, "status") ?? stringField(data, "state");
  if (raw && /fail|error/i.test(raw)) return "failed";
  if (raw && /cancel|kill|interrupt/i.test(raw)) return "cancelled";
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : [];
  if (results.some((result) => /fail|error/i.test(stringField(result, "status") ?? ""))) return "failed";
  if (results.some((result) => /cancel|kill|interrupt/i.test(stringField(result, "status") ?? ""))) return "cancelled";
  return "completed";
}

function asyncCompletionSummary(data: Record<string, unknown>): string {
  const direct = stringField(data, "summary") ?? stringField(data, "result") ?? stringField(data, "message") ?? stringField(data, "error");
  if (direct) return direct;
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : [];
  const summaries = results
    .map((result) => stringField(result, "summary") ?? stringField(result, "finalOutput") ?? stringField(result, "error"))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return summaries.join("\n\n") || "Async subagent run completed.";
}

function taskMatchesAsyncCompletion(task: TaskItem, ids: Set<string>): boolean {
  const ref = task.run?.subagent;
  if (!ref) return false;
  return [ref.asyncId, ref.runId, ref.requestId, task.run?.id, task.owner]
    .some((id) => typeof id === "string" && ids.has(id));
}

function asyncSubagentRef(data: Record<string, unknown>, current: TaskSubagentRef): Partial<TaskSubagentRef> {
  const results = Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : [];
  const values = (key: string) => Array.from(new Set(results
    .map((result) => stringField(result, key))
    .filter((value): value is string => typeof value === "string" && value.length > 0)));
  return {
    asyncId: stringField(data, "id") ?? stringField(data, "asyncId") ?? current.asyncId,
    asyncDir: stringField(data, "asyncDir") ?? current.asyncDir,
    runId: stringField(data, "runId") ?? current.runId,
    sessionFiles: Array.from(new Set([...current.sessionFiles, ...values("sessionFile"), ...values("sessionPath")])),
    artifactOutputs: Array.from(new Set([...current.artifactOutputs, ...values("artifactPath")])),
    savedOutputs: Array.from(new Set([...current.savedOutputs, ...values("savedOutputPath"), ...values("savedOutput")])),
  };
}

export default function piTasksExtension(pi: ExtensionAPI): void {
  const state = getOrCreateState();
  const generation = nextGeneration();

  const markActive = (ctx: ExtensionContext): void => {
    state.activeScope = taskStoreKey(ctx);
  };

  const on = (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown): void => {
    pi.on(eventName as never, async (event: unknown, ctx: ExtensionContext) => {
      if (!isCurrentGeneration(generation)) return undefined;
      markActive(ctx);
      return handler(event, ctx);
    });
  };

  taskStore.setEventAppender((event) => {
    pi.appendEntry(event.customType ?? event.type, event.data ?? {});
  });

  const widget = createTaskWidget(taskStore, (ctx) => runtimeFor(state, ctx), taskStoreKey, (scope, taskId) => state.activity.get(activityKey(scope, taskId)));

  const refresh = (ctx: ExtensionContext): void => {
    runtimeFor(state, ctx);
    widget.refresh(ctx);
  };

  // Record live run activity into ephemeral state so the widget's activity
  // line updates. The widget's in_progress timer (150ms) re-renders and picks
  // this up, so no explicit refresh is needed per tool call. Scope is passed
  // explicitly from the runner so activity lands on the correct session even
  // if activeScope drifts (parallel/background contexts).
  const onActivity = (scope: string, taskId: string, activity: TaskActivity): void => {
    recordActivity(state, scope, taskId, activity);
  };

  const onTaskChanged = (ctx: ExtensionContext, eventType: string, data: Record<string, unknown> = {}): void => {
    const rt = runtimeFor(state, ctx);
    rt.turnsSinceTaskTool = 0;
    refresh(ctx);
    emitTaskEvent(pi, eventType, data);
    // Clear ephemeral activity when a run finishes or a task is deleted so the
    // live-tool line does not linger on a terminal row.
    if (typeof data.taskId === "string" && (eventType === TASK_RUN_FINISHED_EVENT || eventType === TASK_DELETED_EVENT)) {
      clearActivity(state, taskStoreKey(ctx), data.taskId);
    }
    if (eventType === TASK_CREATED_EVENT && typeof data.taskId === "string") labelRecent(pi, ctx, `task: #${data.taskId}`);
    if (eventType === TASK_RUN_FINISHED_EVENT && typeof data.taskId === "string") {
      if (data.status === "completed") labelRecent(pi, ctx, `task done: #${data.taskId}`);
      else if (data.status === "failed") labelRecent(pi, ctx, `task failed: #${data.taskId}`);
      else if (data.status === "cancelled") labelRecent(pi, ctx, `task cancelled: #${data.taskId}`);
    }
  };

  registerTaskTools(pi, onTaskChanged, onActivity);
  registerTaskCommands(pi, taskStore, refresh, taskStoreKey, onTaskChanged);

  const unsubscribeAsyncComplete = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw: unknown) => {
    if (!isCurrentGeneration(generation)) return;
    if (!raw || typeof raw !== "object") return;
    const data = raw as Record<string, unknown>;
    const cwd = stringField(data, "cwd");
    if (!cwd) return;
    const ids = new Set([stringField(data, "id"), stringField(data, "asyncId"), stringField(data, "runId")].filter((id): id is string => typeof id === "string"));
    if (ids.size === 0) return;
    const status = asyncCompletionStatus(data);
    const summary = asyncCompletionSummary(data);
    const sessionId = stringField(data, "sessionId");
    const scopes = new Set<string>();
    if (sessionId) scopes.add(sessionId);
    else {
      scopes.add(cwd);
      for (const [key, rt] of state.runtimes) {
        if (rt.latestCtx?.cwd === cwd) scopes.add(key);
      }
    }
    for (const scope of scopes) {
      for (const task of taskStore.readAll(scope)) {
        if (!taskMatchesAsyncCompletion(task, ids)) continue;
        if (task.status !== "in_progress") continue;
        const applyCompletion = () => {
          const finished = taskStore.finishRun(scope, task.id, status, {
            summary,
            output: summary,
            error: status === "failed" || status === "cancelled" ? summary : undefined,
            subagent: task.run ? asyncSubagentRef(data, task.run.subagent) : undefined,
          });
          taskStore.recordEvidence(scope, task.id, makeEvidence(status === "failed" ? "error" : status === "cancelled" ? "note" : "output", summary, {
            source: SUBAGENT_ASYNC_COMPLETE_EVENT,
            asyncId: stringField(data, "id") ?? stringField(data, "asyncId"),
            runId: stringField(data, "runId"),
          }));
          return finished;
        };
        const shouldPersist = !state.activeScope || state.activeScope === scope;
        const updated = shouldPersist ? applyCompletion() : taskStore.withoutAppending(applyCompletion);
        emitTaskEvent(pi, TASK_RUN_FINISHED_EVENT, { taskId: updated.id, status, async: true });
        for (const [key, rt] of state.runtimes) {
          const ctx = rt.latestCtx;
          if (!ctx || (key !== scope && (sessionId || ctx.cwd !== cwd))) continue;
          rt.turnsSinceTaskTool = 0;
          refresh(ctx);
        }
      }
    }
  });

  on("session_start", async (_event, ctx) => {
    reconstruct(ctx);
    runtimeFor(state, ctx).turnsSinceTaskTool = 0;
    refresh(ctx);
  });

  on("session_tree", async (_event, ctx) => {
    reconstruct(ctx);
    refresh(ctx);
  });

  on("session_shutdown", async (_event, ctx) => {
    const key = taskStoreKey(ctx);
    const rt = runtimeFor(state, ctx);
    cleanupRuntime(ctx, rt);
    state.runtimes.delete(key);
  });

  on("before_agent_start", async (_event, ctx) => {
    reconstruct(ctx);
    refresh(ctx);
  });

  // Compaction durability: compaction removes entries before
  // firstKeptEntryId (the summarized span), including pi-tasks:* events that
  // hold canonical task state. The session-entry model survives restarts, but
  // NOT compaction, unless we anchor full state in the kept region. Appending a
  // TASK_SNAPSHOT here lands it at the tail (index >= firstKeptEntryId), so it
  // survives compaction. The projection treats a snapshot as a reset anchor,
  // so replaying the post-compaction branch rebuilds full state even though
  // earlier task events were summarized away. Best-effort: a failure here must
  // not block compaction or crash the session.
  on("session_before_compact", async (_event, ctx) => {
    try {
      const scope = taskStoreKey(ctx);
      const tasks = taskStore.readAll(scope);
      if (tasks.length === 0) return undefined;
      taskStore.snapshot(scope);
    } catch {
      // Never block compaction on a snapshot failure.
    }
    return undefined;
  });

  on("tool_execution_start", async (_event, ctx) => refresh(ctx));
  on("message_update", async (_event, ctx) => refresh(ctx));
  on("agent_end", async (_event, ctx) => refresh(ctx));

  on("turn_start", async (_event, ctx) => {
    const rt = runtimeFor(state, ctx);
    if (taskStore.readAll(taskStoreKey(ctx)).length > 0) rt.turnsSinceTaskTool += 1;
  });

  on("tool_result", async (event, ctx) => {
    const toolName = (event as { toolName?: unknown }).toolName;
    if (typeof toolName === "string" && TASK_TOOL_NAMES.has(toolName)) {
      runtimeFor(state, ctx).turnsSinceTaskTool = 0;
    }
  });

  on("context", async (event, ctx) => {
    const rt = runtimeFor(state, ctx);
    if (rt.turnsSinceTaskTool < REMINDER_INTERVAL) return undefined;
    if (taskStore.readAll(taskStoreKey(ctx)).length === 0) return undefined;
    rt.turnsSinceTaskTool = 0;
    const messages = (event as { messages?: unknown[] }).messages;
    if (!Array.isArray(messages)) return undefined;
    return {
      messages: [
        ...messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: SYSTEM_REMINDER }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  globalStore[CLEANUP_KEY] = () => {
    if (typeof unsubscribeAsyncComplete === "function") unsubscribeAsyncComplete();
    for (const rt of state.runtimes.values()) {
      if (rt.widgetTimer) clearInterval(rt.widgetTimer);
      rt.widgetTimer = null;
    }
    state.activity.clear();
    taskStore.reset();
  };
}
