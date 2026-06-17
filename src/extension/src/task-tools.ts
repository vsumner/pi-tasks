import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TUnsafe } from "@sinclair/typebox";
import {
  TASK_CREATED_EVENT,
  TASK_DELETED_EVENT,
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_RUN_FINISHED_EVENT,
  TASK_RUN_STARTED_EVENT,
  TASK_STATUS_UPDATED_EVENT,
  TASK_UPDATED_EVENT,
} from "./events.ts";
import { formatOutputFilesSection, formatTaskLine, outputReadHint, runOutputPaths, statusRank, textBlock } from "./format.ts";
import {
  buildTaskPrompt,
  requestSubagentRun,
  subagentRefFromResponse,
  subagentRefFromResult,
  subagentRefFromRun,
  subagentRunStatus,
  summarizeSubagentResponse,
  usageFromResponse,
  usageFromResult,
  type SubagentParamsLike,
  type SubagentSingleResultLike,
  type AgentProgressLike,
} from "./subagents.ts";
import { taskStore, type TaskUpdateInput } from "./task-store.ts";
import { taskStoreKey } from "./session-key.ts";
import { makeEvidence, readyTasks, filterVisible, type TaskAcceptance, type TaskActivity, type TaskActivityHandler, type TaskItem, type TaskRunRecord, type TaskRunStatus, type TaskStatus } from "./task-state.ts";

function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default ? { default: options.default } : {}),
  });
}

const StoredTaskStatusSchema = StringEnum(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"] as const);
const TaskUpdateStatusSchema = StringEnum(["pending", "in_progress", "blocked", "completed", "failed", "cancelled", "deleted"] as const);
const TaskKindSchema = StringEnum(["manual", "subagent", "packet"] as const);
const TaskContextSchema = StringEnum(["fresh", "fork"] as const, { default: "fresh" });
const OutputModeSchema = StringEnum(["inline", "file-only"] as const);

const TaskCreateParams = Type.Object({
  subject: Type.String({ description: "Short actionable task title." }),
  description: Type.String({ description: "Full task prompt, scope, acceptance criteria, and context." }),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous form shown while active, e.g. 'Running tests'." })),
  agent: Type.Optional(Type.String({ description: "pi-subagents agent to use when TaskRun executes this task, e.g. worker, scout, reviewer." })),
  kind: Type.Optional(TaskKindSchema),
  source: Type.Optional(Type.String({ description: "Source extension or actor, e.g. user, agent, pi-goals." })),
  blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete before this task is ready." })),
  blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs blocked by this task." })),
  acceptance: Type.Optional(Type.Any({ description: "pi-subagents acceptance policy passed through to TaskRun unless overridden." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary integration metadata. Use for goalId/packetId/etc." })),
});

type TaskCreateArgs = Static<typeof TaskCreateParams>;

const TaskListParams = Type.Object({
  ready_only: Type.Optional(Type.Boolean({ description: "Only list pending tasks whose dependencies are completed." })),
  status: Type.Optional(StoredTaskStatusSchema),
  sort: Type.Optional(StringEnum(["id", "status", "recent"] as const)),
});

type TaskListArgs = Static<typeof TaskListParams>;

const TaskIdParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
});

type TaskIdArgs = Static<typeof TaskIdParams>;

const TaskUpdateParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  status: Type.Optional(TaskUpdateStatusSchema),
  subject: Type.Optional(Type.String({ description: "New short title." })),
  description: Type.Optional(Type.String({ description: "New full prompt/description." })),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous active label." })),
  agent: Type.Optional(Type.String({ description: "Default pi-subagents agent for TaskRun." })),
  owner: Type.Optional(Type.String({ description: "External owner/run identifier." })),
  source: Type.Optional(Type.String({ description: "Source extension or actor." })),
  kind: Type.Optional(TaskKindSchema),
  blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Replace blockedBy list." })),
  blocks: Type.Optional(Type.Array(Type.String(), { description: "Replace blocks list." })),
  addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Add dependencies." })),
  addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Add dependents." })),
  removeBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Remove dependencies." })),
  removeBlocks: Type.Optional(Type.Array(Type.String(), { description: "Remove dependents." })),
  acceptance: Type.Optional(Type.Any({ description: "Replace acceptance policy." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Merge metadata. Null deletes a key." })),
  note: Type.Optional(Type.String({ description: "Optional evidence/note to append with this update." })),
});

type TaskUpdateArgs = Static<typeof TaskUpdateParams>;

const TaskClaimParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID to claim." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  owner: Type.String({ minLength: 1, description: "Owner identifier claiming the task (agent name, run id, or user)." }),
  start: Type.Optional(Type.Boolean({ description: "Also set status=in_progress. Default false." })),
  force: Type.Optional(Type.Boolean({ description: "Override an existing owner and the one-open-per-owner constraint. Does not bypass terminal or blocked checks." })),
  one_open_per_owner: Type.Optional(Type.Boolean({ description: "Refuse if the owner already owns another non-terminal task. Default false." })),
});

type TaskClaimArgs = Static<typeof TaskClaimParams>;

const TaskRunParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Single task ID to run." })),
  task_id: Type.Optional(Type.String({ description: "Single task ID to run (snake_case alias)." })),
  task_ids: Type.Optional(Type.Array(Type.String(), { description: "Task IDs to run sequentially." })),
  ready: Type.Optional(Type.Boolean({ description: "Run all currently ready tasks. Requires force=false/default dependency checks." })),
  agent: Type.Optional(Type.String({ description: "Override pi-subagents agent." })),
  async: Type.Optional(Type.Boolean({ description: "Run in background through pi-subagents. Default false." })),
  context: Type.Optional(TaskContextSchema),
  model: Type.Optional(Type.String({ description: "Model override for child agents." })),
  additional_context: Type.Optional(Type.String({ description: "Extra context appended to each child prompt." })),
  force: Type.Optional(Type.Boolean({ description: "Run even if task is not pending/ready." })),
  acceptance: Type.Optional(Type.Any({ description: "Override task acceptance policy." })),
  output: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "pi-subagents output setting." })),
  outputMode: Type.Optional(OutputModeSchema),
  skill: Type.Optional(Type.Any({ description: "pi-subagents skill injection setting." })),
  parallel: Type.Optional(Type.Boolean({ description: "Run multiple selected ready tasks through one foreground pi-subagents parallel request. Async parallel is intentionally unsupported." })),
  concurrency: Type.Optional(Type.Number({ description: "Concurrency limit for parallel foreground TaskRun." })),
});

type TaskRunArgs = Static<typeof TaskRunParams>;

const TaskOutputParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  refresh: Type.Optional(Type.Boolean({ description: "If task has an async pi-subagents run, refresh status through pi-subagents." })),
});

type TaskOutputArgs = Static<typeof TaskOutputParams>;

const TaskStatusParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID. If omitted, return a branch-level status summary." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  refresh: Type.Optional(Type.Boolean({ description: "Refresh async pi-subagents status when a task id is provided. Default true." })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"] as const, { description: "Filter branch-level summary by status." })),
});

type TaskStatusArgs = Static<typeof TaskStatusParams>;

const TaskResumeParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  message: Type.Optional(Type.String({ description: "Follow-up message for pi-subagents resume." })),
  index: Type.Optional(Type.Number({ description: "Child index for multi-child subagent runs." })),
});

type TaskResumeArgs = Static<typeof TaskResumeParams>;

const TaskRetryParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID to retry." })),
  task_id: Type.Optional(Type.String({ description: "Task ID to retry (snake_case alias)." })),
  agent: Type.Optional(Type.String({ description: "Override pi-subagents agent." })),
  async: Type.Optional(Type.Boolean({ description: "Retry in background through pi-subagents. Default false." })),
  context: Type.Optional(TaskContextSchema),
  model: Type.Optional(Type.String({ description: "Model override for child agent." })),
  additional_context: Type.Optional(Type.String({ description: "Extra context appended to the retry prompt." })),
  force: Type.Optional(Type.Boolean({ description: "Allow retrying tasks that are not failed/cancelled." })),
  acceptance: Type.Optional(Type.Any({ description: "Override task acceptance policy." })),
  output: Type.Optional(Type.Union([Type.String(), Type.Boolean()], { description: "pi-subagents output setting." })),
  outputMode: Type.Optional(OutputModeSchema),
  skill: Type.Optional(Type.Any({ description: "pi-subagents skill injection setting." })),
});

type TaskRetryArgs = Static<typeof TaskRetryParams>;

const TaskWaitParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  timeout_ms: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds. Default 600000." })),
  poll_ms: Type.Optional(Type.Number({ description: "Polling interval in milliseconds. Default 2000." })),
});

type TaskWaitArgs = Static<typeof TaskWaitParams>;

function taskId(params: { taskId?: string; task_id?: string }): string | undefined {
  return params.taskId ?? params.task_id;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function sortedTasks(tasks: TaskItem[], args: TaskListArgs): TaskItem[] {
  const filtered = args.status ? tasks.filter((task) => task.status === args.status) : tasks;
  if (args.sort === "recent") return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (args.sort === "status") return [...filtered].sort((a, b) => statusRank(a.status) - statusRank(b.status) || Number(a.id) - Number(b.id));
  return [...filtered].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

function taskDetails(task: TaskItem): string {
  const lines = [
    `Task #${task.id}: ${task.title}`,
    `Status: ${task.status}`,
    `Kind: ${task.kind}`,
    task.agent ? `Agent: ${task.agent}` : undefined,
    task.owner ? `Owner: ${task.owner}` : undefined,
    task.source ? `Source: ${task.source}` : undefined,
    task.blockedBy.length ? `Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}` : undefined,
    task.blocks.length ? `Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}` : undefined,
    "",
    task.prompt,
  ].filter((line): line is string => typeof line === "string");

  if (task.run) {
    lines.push("", "Run:", `- id: ${task.run.id}`, `- status: ${task.run.status}`, `- agent: ${task.run.agent}`);
    if (task.run.subagent.runId) lines.push(`- subagent run: ${task.run.subagent.runId}`);
    if (task.run.subagent.asyncId) lines.push(`- async id: ${task.run.subagent.asyncId}`);
    if (task.run.summary) lines.push(`- summary: ${task.run.summary}`);
    if (task.run.error) lines.push(`- error: ${task.run.error}`);
  }

  if (task.evidence.length > 0) {
    lines.push("", "Evidence:");
    for (const evidence of task.evidence.slice(-8)) {
      lines.push(`- [${evidence.kind}] ${evidence.text}`);
    }
  }

  if (Object.keys(task.metadata).length > 0) {
    lines.push("", `Metadata: ${JSON.stringify(task.metadata)}`);
  }

  return lines.join("\n");
}

function taskIdsToRun(args: TaskRunArgs, ctx: ExtensionContext): string[] {
  const ids = args.task_ids ?? (taskId(args) ? [taskId(args)!] : undefined);
  if (ids && ids.length > 0) return ids;
  if (args.ready) return taskStore.ready(taskStoreKey(ctx)).map((task) => task.id);
  throw new Error("TaskRun requires taskId/task_id/task_ids, or ready=true.");
}

function dependencyOutputs(task: TaskItem, all: TaskItem[]): string[] {
  const byId = new Map(all.map((item) => [item.id, item] as const));
  const outputs: string[] = [];
  for (const depId of task.blockedBy) {
    const dep = byId.get(depId);
    if (!dep || dep.status !== "completed") continue;
    const best = dep.run?.output || dep.run?.summary || dep.evidence.at(-1)?.text;
    if (best) outputs.push(`### Task #${dep.id}: ${dep.title}\n${best.slice(0, 4000)}`);
  }
  return outputs;
}

function makeRun(task: TaskItem, agent: string, suffix = Date.now().toString()): TaskRunRecord {
  const ts = new Date().toISOString();
  return {
    id: `task-${task.id}-${suffix}`,
    taskId: task.id,
    status: "running",
    agent,
    startedAt: ts,
    subagent: {
      agent,
      sessionFiles: [],
      savedOutputs: [],
      artifactOutputs: [],
    },
  };
}

function makeResumeRun(task: TaskItem, agent: string): TaskRunRecord {
  const run = makeRun(task, agent, `resume-${Date.now()}`);
  if (!task.run) return run;
  return {
    ...run,
    subagent: {
      ...task.run.subagent,
      agent,
      sessionFiles: [...task.run.subagent.sessionFiles],
      savedOutputs: [...task.run.subagent.savedOutputs],
      artifactOutputs: [...task.run.subagent.artifactOutputs],
    },
  };
}

function canRun(task: TaskItem, all: TaskItem[], force: boolean | undefined): string | undefined {
  if (force) return undefined;
  if (task.status !== "pending") return `not pending (status: ${task.status})`;
  const ready = readyTasks(all).some((candidate) => candidate.id === task.id);
  if (!ready) return `blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ") || "dependency"}`;
  return undefined;
}

function childParamsForTask(task: TaskItem, all: TaskItem[], args: TaskRunArgs | TaskRetryArgs): Record<string, unknown> {
  const agent = args.agent ?? task.agent ?? "worker";
  return {
    agent,
    task: buildTaskPrompt(task, {
      dependencyOutputs: dependencyOutputs(task, all),
      additionalContext: args.additional_context,
    }),
    cwd: task.cwd ?? undefined,
    ...(args.model ? { model: args.model } : {}),
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.outputMode ? { outputMode: args.outputMode } : {}),
    ...(args.skill !== undefined ? { skill: args.skill as string | string[] | boolean } : {}),
    ...(args.acceptance !== undefined || task.acceptance !== undefined
      ? { acceptance: (args.acceptance ?? task.acceptance) as TaskAcceptance }
      : {}),
  };
}

function resultStatus(response: { isError?: boolean; result?: { isError?: boolean } }, result: SubagentSingleResultLike | undefined): TaskRunStatus {
  if (response.isError || response.result?.isError) return "failed";
  if (!result) return "failed";
  if (typeof result.exitCode === "number" && result.exitCode !== 0) return "failed";
  if (typeof result.error === "string" && result.error.length > 0) return "failed";
  return "completed";
}

function resultSummary(result: SubagentSingleResultLike | undefined, fallback: string): string {
  if (!result) return "Missing pi-subagents result for this task.";
  if (typeof result.finalOutput === "string" && result.finalOutput.trim()) return result.finalOutput.trim();
  if (typeof result.error === "string" && result.error.trim()) return result.error.trim();
  if (typeof result.savedOutputPath === "string" && result.savedOutputPath.trim()) return `Output saved: ${result.savedOutputPath}`;
  return fallback;
}

function terminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function taskRunRefId(task: TaskItem): string | undefined {
  const ref = task.run?.subagent;
  return ref?.asyncId ?? ref?.runId ?? task.run?.id ?? task.owner;
}

function firstLine(text: string, max = 240): string {
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function activeFormHint(activeForm: string | undefined): string {
  return activeForm && activeForm.trim()
    ? ""
    : "\nTip: set activeForm to a present-continuous label (e.g. 'Running tests') so the task shows useful progress while in_progress.";
}

function hasVerificationEvidence(task: TaskItem): boolean {
  if (task.evidence.some((e) => e.kind === "proof" || e.kind === "review" || e.passed === true)) {
    return true;
  }
  const acc = task.acceptance;
  if (!acc) return false;
  if (typeof acc === "string") return acc === "verified" || acc === "checked" || acc === "reviewed";
  return (
    acc.level === "verified" ||
    acc.level === "checked" ||
    acc.level === "reviewed" ||
    (Array.isArray(acc.verify) && acc.verify.length > 0)
  );
}

function completionFollowupHint(scope: string): string {
  const all = taskStore.readAll(scope);
  const ready = readyTasks(all);
  const openWork = all.some((task) => !terminalTaskStatus(task.status));
  // Structural verification nudge (mirrors claude-src TodoWriteTool's close-out
  // nudge): when the session just closed out 3+ tasks and none recorded a
  // verification step, push the model to verify before summarizing rather than
  // self-certifying via caveats. Kept as a tool-result hint, not a hard block.
  if (!openWork && all.length >= 3 && !all.some(hasVerificationEvidence)) {
    return "\n\nAll tasks are closed. You closed 3+ tasks without recording a verification step — before writing a final summary, verify the work: run the proof commands from acceptance.verify (or load the fresh-eyes skill) and record the outcome as proof evidence. Do not self-certify completion by listing caveats in your summary.";
  }
  if (ready.length === 0) return "\n\nTask completed. Call TaskList now to confirm no ready follow-up work remains.";
  const shown = ready.slice(0, 5).map((task) => `#${task.id}`).join(", ");
  const more = ready.length > 5 ? `, +${ready.length - 5} more` : "";
  return `\n\nTask completed. Call TaskList now to find newly unblocked work. Ready: ${shown}${more}.`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Task wait cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Task wait cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runOneTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  task: TaskItem,
  args: TaskRunArgs,
  signal: AbortSignal | undefined,
  onChange: (eventType: string, data?: Record<string, unknown>) => void,
  onActivity?: TaskActivityHandler,
): Promise<string> {
  const scope = taskStoreKey(ctx);
  const all = taskStore.readAll(scope);
  const blocker = canRun(task, all, args.force);
  if (blocker) return `#${task.id}: skipped — ${blocker}`;

  const agent = args.agent ?? task.agent ?? "worker";
  const run = makeRun(task, agent);
  taskStore.startRun(scope, task.id, run);
  onChange(TASK_RUN_STARTED_EVENT, { taskId: task.id, runId: run.id });

  const params: SubagentParamsLike = {
    agent,
    task: buildTaskPrompt(task, {
      dependencyOutputs: dependencyOutputs(task, all),
      additionalContext: args.additional_context,
    }),
    cwd: task.cwd ?? ctx.cwd,
    context: args.context ?? "fresh",
    async: args.async ?? false,
    clarify: false,
    // Stream per-tool progress so the widget's live activity line updates.
    includeProgress: true,
    artifacts: true,
    ...(args.model ? { model: args.model } : {}),
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.outputMode ? { outputMode: args.outputMode } : {}),
    ...(args.skill !== undefined ? { skill: args.skill as string | string[] | boolean } : {}),
    ...(args.acceptance !== undefined || task.acceptance !== undefined
      ? { acceptance: (args.acceptance ?? task.acceptance) as TaskAcceptance }
      : {}),
  };

  try {
    const response = await requestSubagentRun(pi, ctx, params, signal, {
      onStarted: () => {
        try { ctx.ui.setStatus("pi-tasks", `Task #${task.id} running via ${agent}`); } catch { /* stale UI */ }
      },
      onUpdate: (update) => {
        // Prefer the per-run progress entry (index 0 for single runs) over the
        // legacy top-level currentTool/toolCount fields.
        const p = update.progress?.[0];
        const tool = (p?.currentTool ?? update.currentTool) ? ` ${p?.currentTool ?? update.currentTool}` : "";
        const count = p?.toolCount ?? update.toolCount ?? 0;
        try { ctx.ui.setStatus("pi-tasks", `Task #${task.id}: ${count} tools${tool}`); } catch { /* stale UI */ }
        // Route live activity into the per-task widget line (swarm-feel).
        // Ephemeral runtime state; never appended to session events.
        const toolName = p?.currentTool ?? update.currentTool;
        if (toolName || count > 0) onActivity?.(scope, task.id, { tool: toolName, count, ts: Date.now() });
      },
    });

    const status = subagentRunStatus(response, args.async === true);
    const summary = summarizeSubagentResponse(response);
    const subagent = subagentRefFromResponse(response.requestId, response, agent);
    const usage = usageFromResponse(response);
    taskStore.finishRun(scope, task.id, status, {
      summary,
      output: summary,
      error: status === "failed" ? response.errorText ?? summary : undefined,
      usage,
      subagent,
    });
    taskStore.recordEvidence(scope, task.id, makeEvidence(status === "failed" ? "error" : "output", summary, {
      runId: run.id,
      subagentRunId: subagent.runId,
      asyncId: subagent.asyncId,
    }));
    onChange(TASK_RUN_FINISHED_EVENT, { taskId: task.id, runId: run.id, status });
    const asyncLaunched = status === "detached" || Boolean(subagent.asyncId);
    const hint = asyncLaunched ? outputReadHint(runOutputPaths(subagent)) : undefined;
    return `#${task.id}: ${status}${subagent.asyncId ? ` (async ${subagent.asyncId})` : ""}${hint ? ` — ${hint}` : ""}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = /cancelled|canceled|aborted/i.test(message);
    const status: TaskRunStatus = cancelled ? "cancelled" : "failed";
    taskStore.finishRun(scope, task.id, status, { summary: message, error: message });
    taskStore.recordEvidence(scope, task.id, makeEvidence(cancelled ? "note" : "error", message, { runId: run.id }));
    onChange(TASK_RUN_FINISHED_EVENT, { taskId: task.id, runId: run.id, status });
    return `#${task.id}: ${status} — ${message}`;
  } finally {
    try { ctx.ui.setStatus("pi-tasks", undefined); } catch { /* stale UI */ }
  }
}

async function runTasksInParallel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ids: string[],
  args: TaskRunArgs,
  signal: AbortSignal | undefined,
  onChange: (eventType: string, data?: Record<string, unknown>) => void,
  onActivity?: TaskActivityHandler,
) {
  const scope = taskStoreKey(ctx);
  const all = taskStore.readAll(scope);
  const skipped: string[] = [];
  const runnable: Array<{ task: TaskItem; run: TaskRunRecord; agent: string }> = [];
  for (const id of ids) {
    const task = taskStore.readTask(scope, id);
    if (!task) {
      skipped.push(`#${id}: not found`);
      continue;
    }
    const blocker = canRun(task, all, args.force);
    if (blocker) {
      skipped.push(`#${id}: skipped — ${blocker}`);
      continue;
    }
    const agent = args.agent ?? task.agent ?? "worker";
    const run = makeRun(task, agent, `parallel-${Date.now()}-${id}`);
    taskStore.startRun(scope, task.id, run);
    onChange(TASK_RUN_STARTED_EVENT, { taskId: task.id, runId: run.id, parallel: true });
    runnable.push({ task, run, agent });
  }

  if (runnable.length === 0) return textResult(skipped.join("\n") || "No runnable tasks.", { results: skipped, tasks: ids.map((id) => taskStore.readTask(scope, id)) });

  const params: SubagentParamsLike = {
    tasks: runnable.map(({ task }) => childParamsForTask(task, all, args)),
    cwd: ctx.cwd,
    context: args.context ?? "fresh",
    async: false,
    clarify: false,
    artifacts: true,
    // Stream per-child progress so each parallel task gets its own activity line.
    includeProgress: true,
    concurrency: Math.max(1, Math.floor(args.concurrency ?? runnable.length)),
  };

  try {
    const response = await requestSubagentRun(pi, ctx, params, signal, {
      onStarted: () => {
        try { ctx.ui.setStatus("pi-tasks", `Running ${runnable.length} tasks in parallel`); } catch { /* stale UI */ }
      },
      onUpdate: (update) => {
        // Parallel updates carry a per-child progress array (each entry has its
        // own index). Fan out an onActivity call per child so every parallel
        // task shows its own live tool line, not one global aggregate.
        const entries = update.progress ?? [];
        if (entries.length > 0) {
          for (const entry of entries) {
            const child = runnable[entry.index];
            if (!child) continue;
            onActivity?.(scope, child.task.id, { tool: entry.currentTool, count: entry.toolCount ?? 0, ts: Date.now() });
          }
          const totalTools = entries.reduce((sum, e) => sum + (e.toolCount ?? 0), 0);
          try { ctx.ui.setStatus("pi-tasks", `Parallel: ${runnable.length} tasks · ${totalTools} tools`); } catch { /* stale UI */ }
        } else {
          const tool = update.currentTool ? ` ${update.currentTool}` : "";
          try { ctx.ui.setStatus("pi-tasks", `Parallel tasks: ${update.toolCount ?? 0} tools${tool}`); } catch { /* stale UI */ }
        }
      },
    });
    const overall = summarizeSubagentResponse(response);
    const results = response.result.details?.results ?? [];
    const lines = [...skipped];
    let completedCount = 0;
    for (const [index, item] of runnable.entries()) {
      const result = results[index];
      const status = resultStatus(response, result);
      const summary = resultSummary(result, overall);
      const subagent = subagentRefFromResult(response.requestId, response, result, item.agent);
      const usage = usageFromResult(result);
      taskStore.finishRun(scope, item.task.id, status, {
        summary,
        output: summary,
        error: status === "failed" ? summary : undefined,
        usage,
        subagent,
      });
      taskStore.recordEvidence(scope, item.task.id, makeEvidence(status === "failed" ? "error" : "output", summary, {
        runId: item.run.id,
        subagentRunId: subagent.runId,
        parallelIndex: index,
      }));
      onChange(TASK_RUN_FINISHED_EVENT, { taskId: item.task.id, runId: item.run.id, status, parallel: true });
      if (status === "completed" && item.task.status !== "completed") completedCount += 1;
      lines.push(`#${item.task.id}: ${status}`);
    }
    return textResult(`${lines.join("\n")}${completedCount > 0 ? completionFollowupHint(scope) : ""}`, { results: lines, tasks: ids.map((id) => taskStore.readTask(scope, id)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = /cancelled|canceled|aborted/i.test(message);
    const status: TaskRunStatus = cancelled ? "cancelled" : "failed";
    const lines = [...skipped];
    for (const item of runnable) {
      taskStore.finishRun(scope, item.task.id, status, { summary: message, error: message });
      taskStore.recordEvidence(scope, item.task.id, makeEvidence(cancelled ? "note" : "error", message, { runId: item.run.id, parallel: true }));
      onChange(TASK_RUN_FINISHED_EVENT, { taskId: item.task.id, runId: item.run.id, status, parallel: true });
      lines.push(`#${item.task.id}: ${status} — ${message}`);
    }
    return textResult(lines.join("\n"), { results: lines, tasks: ids.map((id) => taskStore.readTask(scope, id)) });
  } finally {
    try { ctx.ui.setStatus("pi-tasks", undefined); } catch { /* stale UI */ }
  }
}

const NON_TERMINAL_ASYNC_STATES = new Set(["queued", "running", "detached", "pending", "active", "in_progress"]);

function parseAsyncSummaryStatus(summary: string): { status?: TaskRunStatus; warning?: string } {
  const match = summary.match(/State:\s*([^\s]+)/i);
  const state = match?.[1]?.toLowerCase();
  if (!state) return { warning: "Unrecognized pi-subagents status format; task remains in_progress." };
  if (state === "complete" || state === "completed" || state === "success" || state === "succeeded") return { status: "completed" };
  if (state === "failed" || state === "failure" || state === "error") return { status: "failed" };
  if (state === "cancelled" || state === "canceled" || state === "interrupted") return { status: "cancelled" };
  if (NON_TERMINAL_ASYNC_STATES.has(state)) return {};
  return { warning: `Unrecognized pi-subagents status state "${state}"; task remains in_progress.` };
}

async function refreshAsyncStatus(pi: ExtensionAPI, ctx: ExtensionContext, task: TaskItem, signal?: AbortSignal): Promise<string | undefined> {
  if (task.status !== "in_progress") return undefined;
  if (!task.run) return undefined;
  if (!task.run.subagent.asyncId && task.run.status !== "detached") return undefined;
  const id = task.run.subagent.asyncId ?? task.run.subagent.runId;
  if (!id) return undefined;
  const response = await requestSubagentRun(pi, ctx, { action: "status", id, cwd: ctx.cwd }, signal);
  const summary = summarizeSubagentResponse(response);
  const parsed = parseAsyncSummaryStatus(summary);
  const scope = taskStoreKey(ctx);
  const current = taskStore.readTask(scope, task.id);
  if (current?.status === "in_progress" && parsed.status) {
    taskStore.finishRun(scope, task.id, parsed.status, {
      summary,
      output: summary,
      error: parsed.status === "failed" || parsed.status === "cancelled" ? summary : undefined,
    });
    taskStore.recordEvidence(scope, task.id, makeEvidence(parsed.status === "failed" ? "error" : parsed.status === "cancelled" ? "note" : "output", summary, {
      source: "TaskOutput.refresh",
      asyncId: current.run?.subagent.asyncId,
      runId: current.run?.subagent.runId,
    }));
  }
  return parsed.warning ? `${parsed.warning}\n${summary}` : summary;
}

export type TaskChangeHandler = (ctx: ExtensionContext, eventType: string, data?: Record<string, unknown>) => void;

export async function runTasks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: TaskRunArgs,
  signal: AbortSignal | undefined,
  onTaskChanged: TaskChangeHandler,
  onActivity?: TaskActivityHandler,
) {
  const ids = taskIdsToRun(params, ctx);
  if (ids.length === 0) return textResult("No ready tasks to run.", { results: [] });
  const scope = taskStoreKey(ctx);
  const wantsParallel = ids.length > 1 && (params.parallel === true || (params.concurrency ?? 1) > 1);
  if (wantsParallel) {
    if (params.async === true) {
      return textResult("Parallel async TaskRun is not supported yet because pi-subagents async-complete does not provide stable per-task ids. Run foreground parallel or omit parallel for detached per-task runs.", { results: [], tasks: ids.map((id) => taskStore.readTask(scope, id)) });
    }
    return runTasksInParallel(pi, ctx, ids, params, signal, (eventType, data) => onTaskChanged(ctx, eventType, data), onActivity);
  }

  const lines: string[] = [];
  let completedCount = 0;
  for (const id of ids) {
    if (signal?.aborted) {
      lines.push("TaskRun aborted before remaining tasks started.");
      break;
    }
    const task = taskStore.readTask(scope, id);
    if (!task) {
      lines.push(`#${id}: not found`);
      continue;
    }
    const beforeStatus = task.status;
    const line = await runOneTask(pi, ctx, task, params, signal, (eventType, data) => onTaskChanged(ctx, eventType, data), onActivity);
    const latest = taskStore.readTask(scope, id);
    if (latest?.status === "completed" && beforeStatus !== "completed") completedCount += 1;
    lines.push(line);
  }
  return textResult(`${lines.join("\n")}${completedCount > 0 ? completionFollowupHint(scope) : ""}`, { results: lines, tasks: ids.map((id) => taskStore.readTask(scope, id)) });
}

export async function getTaskStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: TaskStatusArgs,
  signal: AbortSignal | undefined,
  onTaskChanged: TaskChangeHandler,
) {
  const scope = taskStoreKey(ctx);
  const id = taskId(params);
  if (!id) {
    const allTasks = filterVisible(taskStore.readAll(scope));
    const tasks = sortedTasks(allTasks, { status: params.status, sort: "status" });
    const ready = readyTasks(allTasks).length;
    const active = allTasks.filter((task) => task.status === "in_progress").length;
    const failed = allTasks.filter((task) => task.status === "failed").length;
    const lines = [`${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${active} active, ${ready} ready, ${failed} failed`];
    if (tasks.length > 0) lines.push(...tasks.slice(0, 12).map((task) => formatTaskLine(task, allTasks)));
    return textResult(lines.join("\n"), { tasks, ready, active, failed });
  }

  const before = taskStore.readTask(scope, id);
  if (!before) return textResult(`Task #${id} not found.`, { task: null });
  let refreshed: string | undefined;
  if (params.refresh !== false) {
    try { refreshed = await refreshAsyncStatus(pi, ctx, before, signal); } catch (error) { refreshed = `Status refresh failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const latest = taskStore.readTask(scope, id) ?? before;
  if (latest.status !== before.status) onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, status: latest.status });
  const lines = [formatTaskLine(latest, taskStore.readAll(scope))];
  if (latest.run) lines.push(`run: ${latest.run.status} via ${latest.run.agent}${taskRunRefId(latest) ? ` (${taskRunRefId(latest)})` : ""}`);
  if (refreshed) lines.push(`refresh: ${firstLine(refreshed)}`);
  const statusHint = outputReadHint(runOutputPaths(latest.run?.subagent));
  if (statusHint) lines.push(statusHint);
  return textResult(lines.join("\n"), { task: latest, refreshed });
}

export async function getTaskOutput(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: TaskOutputArgs,
  signal: AbortSignal | undefined,
  onTaskChanged: TaskChangeHandler,
) {
  const id = taskId(params);
  if (!id) throw new Error("taskId is required.");
  const scope = taskStoreKey(ctx);
  const task = taskStore.readTask(scope, id);
  if (!task) return textResult(`Task #${id} not found.`, { task: null });
  let refreshed: string | undefined;
  if (params.refresh !== false) {
    try { refreshed = await refreshAsyncStatus(pi, ctx, task, signal); } catch (error) { refreshed = `Status refresh failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  const latest = taskStore.readTask(scope, id) ?? task;
  if (latest.status !== task.status) onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, status: latest.status });
  const paths = runOutputPaths(latest.run?.subagent);
  const sections = [
    `Task #${latest.id} [${latest.status}] ${latest.title}`,
    formatOutputFilesSection(paths),
    refreshed ? `## pi-subagents status\n${refreshed}` : undefined,
    latest.run?.output ? `## Run output\n${latest.run.output}` : undefined,
    latest.evidence.length > 0 ? `## Evidence\n${latest.evidence.map((e) => `- [${e.kind}] ${e.text}`).join("\n")}` : undefined,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return textResult(sections.join("\n\n"), { task: latest });
}

export async function stopTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: TaskIdArgs,
  signal: AbortSignal | undefined,
  onTaskChanged: TaskChangeHandler,
) {
  const id = taskId(params);
  if (!id) throw new Error("taskId is required.");
  const scope = taskStoreKey(ctx);
  const task = taskStore.readTask(scope, id);
  if (!task) return textResult(`Task #${id} not found.`, { task: null });
  if (!task.run) return textResult(`Task #${id} has no run to stop.`, { task });
  const stoppable = task.status === "in_progress" && ["queued", "running", "detached"].includes(task.run.status);
  if (!stoppable) return textResult(`Task #${id} is not in-flight (task: ${task.status}, run: ${task.run.status}).`, { task });
  const ref = subagentRefFromRun(task.run);
  const runId = ref.asyncId ?? ref.runId;
  let message = "";
  if (runId) {
    const response = await requestSubagentRun(pi, ctx, { action: "interrupt", id: runId, cwd: ctx.cwd }, signal);
    message = textBlock(response.result.content) || response.errorText || "Interrupt requested.";
    if (response.isError || response.result.isError) {
      return textResult(`Task #${id} stop failed; task state was not changed.\n\n${message}`, { task, error: message });
    }
  } else {
    message = "No pi-subagents run id was recorded; marking task cancelled locally.";
  }
  const status: TaskRunStatus = "cancelled";
  const updated = taskStore.finishRun(scope, id, status, { summary: message, error: message });
  taskStore.recordEvidence(scope, id, makeEvidence("note", `Cancelled: ${message}`, { source: "TaskStop" }));
  onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, status });
  return textResult(`Task #${id} cancelled.\n\n${message}`, { task: updated });
}

export async function resumeTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: TaskResumeArgs,
  signal: AbortSignal | undefined,
  onTaskChanged: TaskChangeHandler,
) {
  const id = taskId(params);
  if (!id) throw new Error("taskId is required.");
  const scope = taskStoreKey(ctx);
  const task = taskStore.readTask(scope, id);
  if (!task) return textResult(`Task #${id} not found.`, { task: null });
  if (task.status === "in_progress") return textResult(`Task #${id} is already in_progress; wait for it or stop it before resuming.`, { task });
  const runId = taskRunRefId(task);
  if (!runId) return textResult(`Task #${id} has no pi-subagents run id to resume.`, { task });
  const agent = task.run?.agent ?? task.agent ?? "worker";
  const run = makeResumeRun(task, agent);
  taskStore.startRun(scope, id, run);
  onTaskChanged(ctx, TASK_RUN_STARTED_EVENT, { taskId: id, runId: run.id, resumedFrom: runId });
  const message = params.message?.trim() || `Continue task #${task.id}: ${task.title}. Report updated output, proof, and residual risks.`;
  try {
    const response = await requestSubagentRun(pi, ctx, { action: "resume", id: runId, message, index: params.index, cwd: ctx.cwd }, signal);
    const status = subagentRunStatus(response, false);
    const summary = summarizeSubagentResponse(response);
    const subagent = subagentRefFromResponse(response.requestId, response, agent);
    const usage = usageFromResponse(response);
    taskStore.finishRun(scope, id, status, { summary, output: summary, error: status === "failed" ? response.errorText ?? summary : undefined, usage, subagent });
    taskStore.recordEvidence(scope, id, makeEvidence(status === "failed" ? "error" : "output", summary, { source: "TaskResume", resumedFrom: runId }));
    onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, runId: run.id, status });
    return textResult(`Task #${id} resumed: ${status}${status === "completed" ? completionFollowupHint(scope) : ""}`, { task: taskStore.readTask(scope, id) });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const cancelled = /cancelled|canceled|aborted/i.test(messageText);
    const status: TaskRunStatus = cancelled ? "cancelled" : "failed";
    taskStore.finishRun(scope, id, status, { summary: messageText, error: messageText });
    taskStore.recordEvidence(scope, id, makeEvidence(cancelled ? "note" : "error", messageText, { source: "TaskResume", resumedFrom: runId }));
    onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, runId: run.id, status });
    return textResult(`Task #${id} resume ${status}: ${messageText}`, { task: taskStore.readTask(scope, id) });
  }
}

export async function retryTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: TaskRetryArgs,
  signal: AbortSignal | undefined,
  onTaskChanged: TaskChangeHandler,
  onActivity?: TaskActivityHandler,
) {
  const id = taskId(params);
  if (!id) throw new Error("taskId is required.");
  const task = taskStore.readTask(taskStoreKey(ctx), id);
  if (!task) return textResult(`Task #${id} not found.`, { task: null });
  if (!params.force && task.status !== "failed" && task.status !== "cancelled") {
    return textResult(`Task #${id} is ${task.status}; retry only failed/cancelled tasks unless force=true.`, { task });
  }
  taskStore.recordEvidence(taskStoreKey(ctx), id, makeEvidence("note", "Retry requested.", { source: "TaskRetry" }));
  onTaskChanged(ctx, TASK_EVIDENCE_RECORDED_EVENT, { taskId: id });
  return runTasks(pi, ctx, { ...params, taskId: id, force: true }, signal, onTaskChanged, onActivity);
}

export async function waitForTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: TaskWaitArgs,
  signal: AbortSignal | undefined,
  onTaskChanged: TaskChangeHandler,
) {
  const id = taskId(params);
  if (!id) throw new Error("taskId is required.");
  const timeoutMs = Math.min(Math.max(1_000, params.timeout_ms ?? 600_000), 1_800_000);
  const pollMs = Math.min(Math.max(250, params.poll_ms ?? 2_000), 30_000);
  const deadline = Date.now() + timeoutMs;
  const scope = taskStoreKey(ctx);
  let lastRefresh: string | undefined;
  while (Date.now() <= deadline) {
    const task = taskStore.readTask(scope, id);
    if (!task) return textResult(`Task #${id} not found.`, { task: null });
    if (terminalTaskStatus(task.status)) {
      const waitHint = outputReadHint(runOutputPaths(task.run?.subagent));
      return textResult(`Task #${id} finished: ${task.status}${waitHint ? `\n${waitHint}` : ""}${lastRefresh ? `\n${firstLine(lastRefresh)}` : ""}`, { task });
    }
    if (task.run?.subagent.asyncId || task.run?.status === "detached") {
      try {
        const before = task.status;
        lastRefresh = await refreshAsyncStatus(pi, ctx, task, signal);
        const latest = taskStore.readTask(scope, id) ?? task;
        if (latest.status !== before) onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, status: latest.status });
        if (terminalTaskStatus(latest.status)) {
          const waitHint = outputReadHint(runOutputPaths(latest.run?.subagent));
          return textResult(`Task #${id} finished: ${latest.status}${waitHint ? `\n${waitHint}` : ""}\n${firstLine(lastRefresh ?? "")}`, { task: latest });
        }
      } catch (error) {
        lastRefresh = `Status refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
  }
  const task = taskStore.readTask(scope, id);
  return textResult(`Timed out waiting for task #${id}.${lastRefresh ? `\n${firstLine(lastRefresh)}` : ""}`, { task, timedOut: true });
}

export function registerTaskTools(
  pi: ExtensionAPI,
  onTaskChanged: (ctx: ExtensionContext, eventType: string, data?: Record<string, unknown>) => void,
  onActivity?: TaskActivityHandler,
): void {
  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Create a task in the current Pi session branch. Use proactively for complex multi-step work (3+ steps), multi-part requests, or subagent packets. Do not create tasks for a single trivial action or purely informational questions.`,
    promptSnippet: "Create a task with subject, description, activeForm, dependencies, and optional subagent agent",
    promptGuidelines: [
      "Create tasks proactively for complex multi-step work (3+ steps), when the user gives multiple tasks, or when asked for a task list. Skip tasks for a single trivial action or an informational question.",
      "Use one task per bounded deliverable; break complex work into specific, actionable items rather than one vague catch-all task.",
      "Provide subject in imperative form (e.g. 'Run tests') and activeForm in present-continuous form (e.g. 'Running tests'). activeForm is shown while the task is in_progress.",
      "Set agent when the task should be executable through pi-subagents via TaskRun.",
      "Check TaskList first when there may already be a task for the same work; avoid duplicate tasks.",
      "Use source='pi-goals' and metadata {goalId, packetId} for goal packet integration.",
    ],
    parameters: TaskCreateParams,
    executionMode: "sequential",
    async execute(_id, params: TaskCreateArgs, _signal, _onUpdate, ctx) {
      const task = taskStore.createTask(taskStoreKey(ctx), {
        title: params.subject,
        prompt: params.description,
        activeForm: params.activeForm,
        agent: params.agent,
        kind: params.kind,
        source: params.source ?? "agent",
        cwd: ctx.cwd,
        blockedBy: params.blockedBy,
        blocks: params.blocks,
        acceptance: params.acceptance as TaskAcceptance | undefined,
        metadata: params.metadata,
      });
      onTaskChanged(ctx, TASK_CREATED_EVENT, { taskId: task.id });
      const created = `Task #${task.id} created: ${task.title}`;
      return textResult(`${created}${activeFormHint(task.activeForm)}`, { task, taskEvent: { customType: TASK_CREATED_EVENT, data: { taskId: task.id, task } } });
    },
    renderCall(args: { subject?: unknown }, theme: Theme) {
      const subject = typeof args.subject === "string" ? args.subject : "task";
      return new Text(theme.fg("toolTitle", theme.bold("TaskCreate ")) + theme.fg("muted", subject), 0, 0);
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: "List tasks on the current Pi session branch. Use ready_only to find unblocked pending work.",
    promptGuidelines: [
      "Call TaskList after completing a task to find ready follow-up work.",
      "Use ready_only=true to find tasks that are pending and unblocked by unresolved dependencies; check owner before claiming or starting work.",
      "Prefer ready tasks in lowest-ID order when multiple tasks are available, because earlier tasks often set up context for later ones.",
    ],
    parameters: TaskListParams,
    async execute(_id, params: TaskListArgs, _signal, _onUpdate, ctx) {
      const scope = taskStoreKey(ctx);
      // allTasks is the full set (used for accurate blocker resolution in
      // formatTaskLine); only the listed rows are filtered to visible tasks so
      // internal bookkeeping tasks never reach the model.
      const allTasks = taskStore.readAll(scope);
      const source = params.ready_only ? taskStore.ready(scope) : allTasks;
      const tasks = sortedTasks(filterVisible(source), params);
      if (tasks.length === 0) return textResult(params.ready_only ? "No ready tasks." : "No tasks found.", { tasks });
      return textResult(tasks.map((task) => formatTaskLine(task, allTasks)).join("\n"), { tasks });
    },
  });

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: "Get full task details, dependencies, evidence, and subagent run metadata.",
    parameters: TaskIdParams,
    async execute(_id, params: TaskIdArgs, _signal, _onUpdate, ctx) {
      const id = taskId(params);
      if (!id) throw new Error("taskId is required.");
      const task = taskStore.readTask(taskStoreKey(ctx), id);
      if (!task) return textResult(`Task #${id} not found.`, { task: null });
      return textResult(taskDetails(task), { task });
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Update a task's status, subject, dependencies, or notes. Mark in_progress before starting direct work and completed only after the work is fully done with proof. Prefer blocked over false completion. Use status='deleted' to delete a task.`,
    promptGuidelines: [
      "Mark a task in_progress immediately before starting work on it, and complete it immediately after finishing — do not batch status updates.",
      "Keep at most one task in_progress at a time; start a new task only after completing or blocking the current one. Intentional parallel TaskRun is allowed when work is genuinely independent.",
      "Only mark completed when the work is fully done and you have proof (tests pass, implementation complete). Never complete if tests fail, the implementation is partial, or errors are unresolved.",
      "If blocked or unable to finish, keep the task in_progress or set it blocked, and create a separate task for the blocker rather than marking false completion.",
      "Read the latest task state with TaskGet before updating if there is any chance another agent changed it.",
      "After marking a task completed, call TaskList ready_only=true to find newly unblocked work or confirm no ready tasks remain.",
      "Use addBlockedBy/addBlocks to encode ordering instead of prose-only ordering.",
    ],
    parameters: TaskUpdateParams,
    executionMode: "sequential",
    async execute(_id, params: TaskUpdateArgs, _signal, _onUpdate, ctx) {
      const id = taskId(params);
      if (!id) throw new Error("taskId is required.");
      if (params.status === "deleted") {
        taskStore.deleteTask(taskStoreKey(ctx), id);
        onTaskChanged(ctx, TASK_DELETED_EVENT, { taskId: id });
        return textResult(`Task #${id} deleted.`, { taskId: id });
      }

      const update: TaskUpdateInput = {
        status: params.status,
        title: params.subject,
        prompt: params.description,
        activeForm: params.activeForm,
        agent: params.agent,
        owner: params.owner,
        source: params.source,
        kind: params.kind,
        blockedBy: params.blockedBy,
        blocks: params.blocks,
        addBlockedBy: params.addBlockedBy,
        addBlocks: params.addBlocks,
        removeBlockedBy: params.removeBlockedBy,
        removeBlocks: params.removeBlocks,
        acceptance: params.acceptance as TaskAcceptance | undefined,
        metadata: params.metadata,
      };
      const scope = taskStoreKey(ctx);
      const before = taskStore.readTask(scope, id);
      let task = taskStore.updateTask(scope, id, update);
      if (params.note?.trim()) {
        task = taskStore.recordEvidence(scope, id, makeEvidence("note", params.note.trim(), { source: "TaskUpdate" }));
        onTaskChanged(ctx, TASK_EVIDENCE_RECORDED_EVENT, { taskId: id });
      } else {
        onTaskChanged(ctx, TASK_UPDATED_EVENT, { taskId: id });
      }
      const completionHint = params.status === "completed" && before?.status !== "completed"
        ? completionFollowupHint(scope)
        : "";
      return textResult(`Updated task #${id}: ${task.status} — ${task.title}${completionHint}`, { task });
    },
  });

  pi.registerTool({
    name: "TaskClaim",
    label: "TaskClaim",
    description: `Safely claim ownership of a task. Sets owner (and optionally status=in_progress) only when the task is not terminal, not blocked, and not already owned by another owner (unless force=true). Use this instead of TaskUpdate owner when you need claim-or-report semantics. Existing TaskUpdate owner assignment is unchanged.`,
    promptGuidelines: [
      "Use TaskClaim to atomically take ownership of a task before starting work on it; it reports structured failure reasons rather than silently overwriting an existing owner.",
      "A claim fails with invalid_owner for blank owners, already_terminal for completed/failed/cancelled tasks, blocked when dependencies are unresolved, already_claimed when another owner holds the task, and owner_busy when one_open_per_owner is set and you already own open work.",
      "Pass force=true to override already_claimed and owner_busy only; terminal and blocked tasks cannot be force-claimed.",
    ],
    parameters: TaskClaimParams,
    executionMode: "sequential",
    async execute(_id, params: TaskClaimArgs, _signal, _onUpdate, ctx) {
      const id = taskId(params);
      if (!id) throw new Error("taskId is required.");
      const scope = taskStoreKey(ctx);
      const result = taskStore.claimTask(scope, id, {
        owner: params.owner,
        start: params.start,
        force: params.force,
        oneOpenPerOwner: params.one_open_per_owner,
      });
      if (!result.success) {
        const extras: string[] = [];
        if (result.blockedByTasks?.length) extras.push(`blocked by ${result.blockedByTasks.map((bid) => `#${bid}`).join(", ")}`);
        if (result.busyWithTasks?.length) extras.push(`owner busy with ${result.busyWithTasks.map((bid) => `#${bid}`).join(", ")}`);
        const suffix = extras.length ? ` (${extras.join("; ")})` : "";
        return textResult(`Claim failed for task #${id}: ${result.reason}${suffix}`, { claimed: false, ...result });
      }
      const claimedTask = result.task;
      if (!claimedTask) return textResult(`Claim failed for task #${id}: task_not_found`, { claimed: false, reason: "task_not_found" });
      onTaskChanged(ctx, TASK_UPDATED_EVENT, { taskId: id });
      return textResult(`Claimed task #${id} for ${claimedTask.owner}${params.start ? " (in_progress)" : ""}`, { claimed: true, task: claimedTask });
    },
  });

  pi.registerTool({
    name: "TaskRun",
    label: "TaskRun",
    description: `Execute task(s) through pi-subagents. This is the only execution path for subagent tasks; do not separately call subagent for the same task.`,
    promptGuidelines: [
      "Only run pending ready tasks unless force=true is intentional.",
      "Default to one task at a time. Use parallel=true for genuinely independent tasks, and async=true only for independent background work you do not need before proceeding.",
      "Foreground runs are preferred when the parent must inspect output and update state immediately.",
      "Do not poll or peek at async output unless the user asks or a completion notification arrives; trust detached runs until they complete.",
      "For context='fresh', the task prompt must be self-contained with paths, constraints, and proof expectations. For context='fork', avoid model overrides unless the tradeoff is explicit.",
      "Subagent output is not user-visible until the parent summarizes it; after TaskRun returns, report the result and evidence to the user.",
    ],
    parameters: TaskRunParams,
    executionMode: "sequential",
    async execute(_id, params: TaskRunArgs, signal, _onUpdate, ctx) {
      return runTasks(pi, ctx, params, signal ?? undefined, onTaskChanged, onActivity);
    },
  });

  pi.registerTool({
    name: "TaskStatus",
    label: "TaskStatus",
    description: "Show lightweight task status. For async tasks, refresh pi-subagents status without dumping full output.",
    parameters: TaskStatusParams,
    executionMode: "sequential",
    async execute(_id, params: TaskStatusArgs, signal, _onUpdate, ctx) {
      return getTaskStatus(pi, ctx, params, signal ?? undefined, onTaskChanged);
    },
  });

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: "Show latest task output/evidence. For async pi-subagents runs, optionally refresh status via pi-subagents.",
    parameters: TaskOutputParams,
    executionMode: "sequential",
    async execute(_id, params: TaskOutputArgs, signal, _onUpdate, ctx) {
      return getTaskOutput(pi, ctx, params, signal ?? undefined, onTaskChanged);
    },
  });

  pi.registerTool({
    name: "TaskResume",
    label: "TaskResume",
    description: "Resume a paused/interrupted pi-subagents run associated with a task.",
    parameters: TaskResumeParams,
    executionMode: "sequential",
    async execute(_id, params: TaskResumeArgs, signal, _onUpdate, ctx) {
      return resumeTask(pi, ctx, params, signal ?? undefined, onTaskChanged);
    },
  });

  pi.registerTool({
    name: "TaskRetry",
    label: "TaskRetry",
    description: "Retry a failed/cancelled task through pi-subagents while preserving prior evidence.",
    parameters: TaskRetryParams,
    executionMode: "sequential",
    async execute(_id, params: TaskRetryArgs, signal, _onUpdate, ctx) {
      return retryTask(pi, ctx, params, signal ?? undefined, onTaskChanged, onActivity);
    },
  });

  pi.registerTool({
    name: "TaskWait",
    label: "TaskWait",
    description: "Wait for an async task to finish by polling pi-subagents status with a bounded timeout.",
    parameters: TaskWaitParams,
    executionMode: "sequential",
    async execute(_id, params: TaskWaitArgs, signal, _onUpdate, ctx) {
      return waitForTask(pi, ctx, params, signal ?? undefined, onTaskChanged);
    },
  });

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: "Interrupt/cancel an in-flight pi-subagents task run and mark the task cancelled.",
    parameters: TaskIdParams,
    executionMode: "sequential",
    async execute(_id, params: TaskIdArgs, signal, _onUpdate, ctx) {
      return stopTask(pi, ctx, params, signal ?? undefined, onTaskChanged);
    },
  });
}
