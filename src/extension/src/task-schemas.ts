// ---------------------------------------------------------------------------
// Task tool parameter schemas + I/O shaping
//
// Pure, declarative layer: TypeBox parameter schemas for every task tool, the
// inferred argument types, and the small pure helpers that marshal tool
// input/output (taskId alias resolution, text result wrapping, list sorting,
// and the human-readable task detail block). Kept separate from
// task-run-engine.ts (orchestration) and task-tools.ts (registration) so the
// tool contract surface is easy to audit and extend in one place.
// ---------------------------------------------------------------------------

import { Type, type Static, type TUnsafe } from "@sinclair/typebox";
import { statusRank } from "./format.ts";
import type { TaskItem } from "./task-state.ts";

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

export const TaskCreateParams = Type.Object({
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

export type TaskCreateArgs = Static<typeof TaskCreateParams>;

export const TaskListParams = Type.Object({
  ready_only: Type.Optional(Type.Boolean({ description: "Only list pending tasks whose dependencies are completed." })),
  status: Type.Optional(StoredTaskStatusSchema),
  sort: Type.Optional(StringEnum(["id", "status", "recent"] as const)),
});

export type TaskListArgs = Static<typeof TaskListParams>;

export const TaskIdParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
});

export type TaskIdArgs = Static<typeof TaskIdParams>;

export const TaskUpdateParams = Type.Object({
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

export type TaskUpdateArgs = Static<typeof TaskUpdateParams>;

export const TaskClaimParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID to claim." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  owner: Type.String({ minLength: 1, description: "Owner identifier claiming the task (agent name, run id, or user)." }),
  start: Type.Optional(Type.Boolean({ description: "Also set status=in_progress. Default false." })),
  force: Type.Optional(Type.Boolean({ description: "Override an existing owner and the one-open-per-owner constraint. Does not bypass terminal or blocked checks." })),
  one_open_per_owner: Type.Optional(Type.Boolean({ description: "Refuse if the owner already owns another non-terminal task. Default false." })),
});

export type TaskClaimArgs = Static<typeof TaskClaimParams>;

export const TaskRunParams = Type.Object({
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

export type TaskRunArgs = Static<typeof TaskRunParams>;

export const TaskOutputParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  refresh: Type.Optional(Type.Boolean({ description: "If task has an async pi-subagents run, refresh status through pi-subagents." })),
});

export type TaskOutputArgs = Static<typeof TaskOutputParams>;

export const TaskStatusParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID. If omitted, return a branch-level status summary." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  refresh: Type.Optional(Type.Boolean({ description: "Refresh async pi-subagents status when a task id is provided. Default true." })),
  status: Type.Optional(StringEnum(["pending", "in_progress", "blocked", "completed", "failed", "cancelled"] as const, { description: "Filter branch-level summary by status." })),
});

export type TaskStatusArgs = Static<typeof TaskStatusParams>;

export const TaskResumeParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  message: Type.Optional(Type.String({ description: "Follow-up message for pi-subagents resume." })),
  index: Type.Optional(Type.Number({ description: "Child index for multi-child subagent runs." })),
});

export type TaskResumeArgs = Static<typeof TaskResumeParams>;

export const TaskRetryParams = Type.Object({
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

export type TaskRetryArgs = Static<typeof TaskRetryParams>;

export const TaskWaitParams = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Task ID." })),
  task_id: Type.Optional(Type.String({ description: "Task ID (snake_case alias)." })),
  timeout_ms: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds. Default 600000." })),
  poll_ms: Type.Optional(Type.Number({ description: "Polling interval in milliseconds. Default 2000." })),
});

export type TaskWaitArgs = Static<typeof TaskWaitParams>;

/** Resolve the camelCase/snake_case task id alias used across every task tool. */
export function taskId(params: { taskId?: string; task_id?: string }): string | undefined {
  return params.taskId ?? params.task_id;
}

/** Wrap a text response with optional structured details for the tool result. */
export function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Sort a task list for TaskList/TaskStatus output by id (default), status, or recency. */
export function sortedTasks(tasks: TaskItem[], args: TaskListArgs): TaskItem[] {
  const filtered = args.status ? tasks.filter((task) => task.status === args.status) : tasks;
  if (args.sort === "recent") return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (args.sort === "status") return [...filtered].sort((a, b) => statusRank(a.status) - statusRank(b.status) || Number(a.id) - Number(b.id));
  return [...filtered].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

/** Human-readable multi-line detail block for TaskGet output. */
export function taskDetails(task: TaskItem): string {
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
