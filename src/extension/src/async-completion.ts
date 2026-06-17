// ---------------------------------------------------------------------------
// pi-subagents async-completion payload parsing
//
// The `subagent:async-complete` event from pi-subagents carries an untyped
// `Record<string, unknown>` payload (status, summary, per-result fields, ids).
// These pure helpers normalize that payload into the typed values the
// async-complete handler needs (TaskRunStatus, summary text, subagent ref
// merge, task-id matching). They were previously inlined in index.ts; pulling
// them out makes the parsing unit-testable in isolation and shrinks the
// extension entrypoint. No orchestration lives here — scope resolution, the
// activeScope persistence decision, and refresh fan-out stay in index.ts
// because they are coupled to session-scoped runtime state.
//
// Status vocabulary note: asyncCompletionStatus matches structured status
// strings via regex (fail|error → failed, cancel|kill|interrupt → cancelled).
// This is intentionally distinct from task-run-engine.parseAsyncSummaryStatus
// (exact-token match on a free-text "State:" line) and subagents.subagentRunStatus
// (typed checks on SlashSubagentResponseLike). The three consume different
// input shapes; unifying them would change matching semantics.
// ---------------------------------------------------------------------------

import type { TaskItem, TaskRunStatus, TaskSubagentRef } from "./task-state.ts";

export type AsyncCompleteResult = Record<string, unknown>;

/** Read a non-empty string field from an untyped payload. */
export function stringField(obj: AsyncCompleteResult, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Map a pi-subagents async-complete payload to a terminal run status. */
export function asyncCompletionStatus(data: AsyncCompleteResult): TaskRunStatus {
  if (data.success === false) return "failed";
  const raw = stringField(data, "status") ?? stringField(data, "state");
  if (raw && /fail|error/i.test(raw)) return "failed";
  if (raw && /cancel|kill|interrupt/i.test(raw)) return "cancelled";
  const results = Array.isArray(data.results) ? data.results as AsyncCompleteResult[] : [];
  if (results.some((result) => /fail|error/i.test(stringField(result, "status") ?? ""))) return "failed";
  if (results.some((result) => /cancel|kill|interrupt/i.test(stringField(result, "status") ?? ""))) return "cancelled";
  return "completed";
}

/** Best-effort summary from an async-complete payload, falling back to per-result outputs. */
export function asyncCompletionSummary(data: AsyncCompleteResult): string {
  const direct = stringField(data, "summary") ?? stringField(data, "result") ?? stringField(data, "message") ?? stringField(data, "error");
  if (direct) return direct;
  const results = Array.isArray(data.results) ? data.results as AsyncCompleteResult[] : [];
  const summaries = results
    .map((result) => stringField(result, "summary") ?? stringField(result, "finalOutput") ?? stringField(result, "error"))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return summaries.join("\n\n") || "Async subagent run completed.";
}

/**
 * Does this task plausibly correspond to an async completion carrying any of
 * these ids? Matches against the task's recorded async/run/request ids, its
 * run id, and its owner so completions land even when pi-subagents reports a
 * different id shape than the one recorded at launch.
 */
export function taskMatchesAsyncCompletion(task: TaskItem, ids: Set<string>): boolean {
  const ref = task.run?.subagent;
  if (!ref) return false;
  return [ref.asyncId, ref.runId, ref.requestId, task.run?.id, task.owner]
    .some((id) => typeof id === "string" && ids.has(id));
}

/** Merge an async-complete payload into the current subagent ref, unioning the file lists. */
export function asyncSubagentRef(data: AsyncCompleteResult, current: TaskSubagentRef): Partial<TaskSubagentRef> {
  const results = Array.isArray(data.results) ? data.results as AsyncCompleteResult[] : [];
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
