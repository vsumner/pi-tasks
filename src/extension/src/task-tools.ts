import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  TASK_CREATED_EVENT,
  TASK_DELETED_EVENT,
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_UPDATED_EVENT,
} from "./events.ts";
import { formatTaskLine } from "./format.ts";
import { taskStore, type TaskUpdateInput } from "./task-store.ts";
import { taskStoreKey } from "./session-key.ts";
import { acceptanceValidationError, validateAcceptance, makeEvidence, filterVisible, type TaskAcceptance, type TaskActivityHandler, type TaskStatus } from "./task-state.ts";
import {
  TaskCreateParams,
  TaskListParams,
  TaskIdParams,
  TaskUpdateParams,
  TaskClaimParams,
  TaskRunParams,
  TaskOutputParams,
  TaskStatusParams,
  TaskResumeParams,
  TaskRetryParams,
  TaskWaitParams,
  type TaskCreateArgs,
  type TaskListArgs,
  type TaskIdArgs,
  type TaskUpdateArgs,
  type TaskClaimArgs,
  type TaskRunArgs,
  type TaskOutputArgs,
  type TaskStatusArgs,
  type TaskResumeArgs,
  type TaskRetryArgs,
  type TaskWaitArgs,
  taskId,
  textResult,
  sortedTasks,
  taskDetails,
} from "./task-schemas.ts";
import {
  activeFormHint,
  completionFollowupHint,
  getTaskOutput,
  getTaskStatus,
  resumeTask,
  retryTask,
  runTasks,
  stopTask,
  waitForTask,
} from "./task-run-engine.ts";

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
      const acceptanceErrors = validateAcceptance(params.acceptance);
      if (acceptanceErrors.length > 0) throw acceptanceValidationError(acceptanceErrors);
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
    // Pure read: no mutation, no onTaskChanged, no subagent I/O. Safe to run
    // in parallel with other tool calls. (TaskStatus/TaskOutput stay
    // sequential: they call refreshAsyncStatus and fire onTaskChanged/
    // finishRun on status change, so concurrent calls could double-fire.)
    executionMode: "parallel",
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
    // Pure read of canonical state by id. Safe to run in parallel.
    executionMode: "parallel",
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
      const acceptanceErrors = validateAcceptance(params.acceptance);
      if (acceptanceErrors.length > 0) throw acceptanceValidationError(acceptanceErrors);
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
