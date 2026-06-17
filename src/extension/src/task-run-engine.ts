// ---------------------------------------------------------------------------
// Task run engine
//
// Orchestration layer between the tool/command surface and the pi-subagents
// bridge + task-store. Owns the actual run lifecycle: foreground single-task
// runs, foreground parallel fan-out, async launch + status refresh, resume,
// retry, wait/stop, and the close-out "follow-up work" + verification nudges.
// Kept separate from task-schemas.ts (declarative tool contract) and
// task-tools.ts (tool registration wiring) so the run control flow reads as
// one cohesive module.
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_RUN_FINISHED_EVENT,
  TASK_RUN_STARTED_EVENT,
} from "./events.ts";
import { formatOutputFilesSection, formatTaskLine, outputReadHint, runOutputPaths, textBlock } from "./format.ts";
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
import { taskStore } from "./task-store.ts";
import { taskStoreKey } from "./session-key.ts";
import {
  indexById,
  isTerminalStatus,
  isTaskBlocked,
  makeEvidence,
  readyTasks,
  filterVisible,
  type TaskAcceptance,
  type TaskActivity,
  type TaskActivityHandler,
  type TaskItem,
  type TaskRunRecord,
  type TaskRunStatus,
} from "./task-state.ts";
import {
  type TaskRunArgs,
  type TaskRetryArgs,
  type TaskStatusArgs,
  type TaskOutputArgs,
  type TaskResumeArgs,
  type TaskWaitArgs,
  type TaskIdArgs,
  taskId,
  textResult,
  sortedTasks,
} from "./task-schemas.ts";

/** Update the pi-tasks status line, swallowing errors when the UI is stale
 *  during session replacement (hot reload, /fork, /tree). Centralizes the
 *  repeated `try { ctx.ui.setStatus(...) } catch {}` noise. */
function safeSetStatus(ctx: ExtensionContext, text: string | undefined): void {
  try { ctx.ui.setStatus("pi-tasks", text); } catch { /* UI may be stale during session replacement */ }
}

function taskIdsToRun(args: TaskRunArgs, ctx: ExtensionContext): string[] {
  const ids = args.task_ids ?? (taskId(args) ? [taskId(args)!] : undefined);
  if (ids && ids.length > 0) return ids;
  if (args.ready) return taskStore.ready(taskStoreKey(ctx)).map((task) => task.id);
  throw new Error("TaskRun requires taskId/task_id/task_ids, or ready=true.");
}

function dependencyOutputs(task: TaskItem, all: TaskItem[]): string[] {
  const byId = indexById(all);
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
  // task is already confirmed pending, so it is ready iff it is not blocked.
  // Checking directly avoids building the full ready list (the prior
  // readyTasks(all).some(...) rebuilt the id index once per candidate task).
  if (isTaskBlocked(task, all)) return `blocked by ${task.blockedBy.map((id) => `#${id}`).join(", ") || "dependency"}`;
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

function taskRunRefId(task: TaskItem): string | undefined {
  const ref = task.run?.subagent;
  return ref?.asyncId ?? ref?.runId ?? task.run?.id ?? task.owner;
}

function firstLine(text: string, max = 240): string {
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0)?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function activeFormHint(activeForm: string | undefined): string {
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

export function completionFollowupHint(scope: string): string {
  const all = taskStore.readAll(scope);
  const ready = readyTasks(all);
  const openWork = all.some((task) => !isTerminalStatus(task.status));
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
        safeSetStatus(ctx, `Task #${task.id} running via ${agent}`);
      },
      onUpdate: (update) => {
        // Prefer the per-run progress entry (index 0 for single runs) over the
        // legacy top-level currentTool/toolCount fields.
        const p = update.progress?.[0];
        const tool = (p?.currentTool ?? update.currentTool) ? ` ${p?.currentTool ?? update.currentTool}` : "";
        const count = p?.toolCount ?? update.toolCount ?? 0;
        safeSetStatus(ctx, `Task #${task.id}: ${count} tools${tool}`);
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
    taskStore.completeRun(scope, task.id, status, {
      summary,
      error: status === "failed" ? response.errorText ?? summary : undefined,
      usage,
      subagent,
      evidenceMetadata: {
        runId: run.id,
        subagentRunId: subagent.runId,
        asyncId: subagent.asyncId,
      },
    });
    onChange(TASK_RUN_FINISHED_EVENT, { taskId: task.id, runId: run.id, status });
    const asyncLaunched = status === "detached" || Boolean(subagent.asyncId);
    const hint = asyncLaunched ? outputReadHint(runOutputPaths(subagent)) : undefined;
    return `#${task.id}: ${status}${subagent.asyncId ? ` (async ${subagent.asyncId})` : ""}${hint ? ` — ${hint}` : ""}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = /cancelled|canceled|aborted/i.test(message);
    const status: TaskRunStatus = cancelled ? "cancelled" : "failed";
    taskStore.completeRun(scope, task.id, status, {
      summary: message,
      error: message,
      evidenceMetadata: { runId: run.id },
    });
    onChange(TASK_RUN_FINISHED_EVENT, { taskId: task.id, runId: run.id, status });
    return `#${task.id}: ${status} — ${message}`;
  } finally {
    safeSetStatus(ctx, undefined);
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
        safeSetStatus(ctx, `Running ${runnable.length} tasks in parallel`);
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
          safeSetStatus(ctx, `Parallel: ${runnable.length} tasks · ${totalTools} tools`);
        } else {
          const tool = update.currentTool ? ` ${update.currentTool}` : "";
          safeSetStatus(ctx, `Parallel tasks: ${update.toolCount ?? 0} tools${tool}`);
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
      taskStore.completeRun(scope, item.task.id, status, {
        summary,
        error: status === "failed" ? summary : undefined,
        usage,
        subagent,
        evidenceMetadata: {
          runId: item.run.id,
          subagentRunId: subagent.runId,
          parallelIndex: index,
        },
      });
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
      taskStore.completeRun(scope, item.task.id, status, {
        summary: message,
        error: message,
        evidenceMetadata: { runId: item.run.id, parallel: true },
      });
      onChange(TASK_RUN_FINISHED_EVENT, { taskId: item.task.id, runId: item.run.id, status, parallel: true });
      lines.push(`#${item.task.id}: ${status} — ${message}`);
    }
    return textResult(lines.join("\n"), { results: lines, tasks: ids.map((id) => taskStore.readTask(scope, id)) });
  } finally {
    safeSetStatus(ctx, undefined);
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
    taskStore.completeRun(scope, task.id, parsed.status, {
      summary,
      error: parsed.status === "failed" || parsed.status === "cancelled" ? summary : undefined,
      evidenceMetadata: {
        source: "TaskOutput.refresh",
        asyncId: current.run?.subagent.asyncId,
        runId: current.run?.subagent.runId,
      },
    });
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
    taskStore.completeRun(scope, id, status, {
      summary,
      error: status === "failed" ? response.errorText ?? summary : undefined,
      usage,
      subagent,
      evidenceMetadata: { source: "TaskResume", resumedFrom: runId },
    });
    onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, runId: run.id, status });
    return textResult(`Task #${id} resumed: ${status}${status === "completed" ? completionFollowupHint(scope) : ""}`, { task: taskStore.readTask(scope, id) });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const cancelled = /cancelled|canceled|aborted/i.test(messageText);
    const status: TaskRunStatus = cancelled ? "cancelled" : "failed";
    taskStore.completeRun(scope, id, status, {
      summary: messageText,
      error: messageText,
      evidenceMetadata: { source: "TaskResume", resumedFrom: runId },
    });
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
    if (isTerminalStatus(task.status)) {
      const waitHint = outputReadHint(runOutputPaths(task.run?.subagent));
      return textResult(`Task #${id} finished: ${task.status}${waitHint ? `\n${waitHint}` : ""}${lastRefresh ? `\n${firstLine(lastRefresh)}` : ""}`, { task });
    }
    if (task.run?.subagent.asyncId || task.run?.status === "detached") {
      try {
        const before = task.status;
        lastRefresh = await refreshAsyncStatus(pi, ctx, task, signal);
        const latest = taskStore.readTask(scope, id) ?? task;
        if (latest.status !== before) onTaskChanged(ctx, TASK_RUN_FINISHED_EVENT, { taskId: id, status: latest.status });
        if (isTerminalStatus(latest.status)) {
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
