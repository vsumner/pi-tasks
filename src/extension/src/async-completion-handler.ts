// ---------------------------------------------------------------------------
// subagent:async-complete handler
//
// Extracted from index.ts so the scope-resolution and per-task completion
// logic for async subagent runs is unit-testable in isolation. The pure
// payload parsers live in async-completion.ts; this module owns the
// store-mutation + event-emission orchestration that previously sat inline in
// the extension entrypoint.
//
// What stays in index.ts: the generation guard, the pi.events.on subscription,
// and the widget refresh fan-out (those touch the ephemeral per-session
// runtime map and the refresh closure). Everything that decides *which* tasks
// to close out and *how* is here.
// ---------------------------------------------------------------------------

import {
  asyncCompletionStatus,
  asyncCompletionSummary,
  asyncSubagentRef,
  stringField,
  taskMatchesAsyncCompletion,
  type AsyncCompleteResult,
} from "./async-completion.ts";
import { TASK_RUN_FINISHED_EVENT } from "./events.ts";
import type { TaskRunStatus } from "./task-state.ts";
import type { TaskStore } from "./task-store.ts";

/** pi-subagents event carrying a background-run completion. */
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** A runtime scope consulted during completion routing. */
export interface CompletionRuntimeScope {
  /** Scope key (session id or cwd) the runtime owns. */
  key: string;
  /** Latest cwd observed for that runtime, if any. */
  cwd?: string;
}

/**
 * Resolve which task-store scopes an async-completion payload applies to.
 *
 * If a `sessionId` is present, the completion is scoped to that single session.
 * Otherwise it falls back to the payload cwd plus every runtime whose latest
 * context matches that cwd — so a completion reported for a shared cwd still
 * lands on every session that was running there.
 *
 * Pure over its inputs; safe to unit-test without a store or Pi runtime.
 */
export function resolveCompletionScopes(
  cwd: string,
  sessionId: string | undefined,
  runtimeScopes: Iterable<CompletionRuntimeScope>,
): Set<string> {
  const scopes = new Set<string>();
  if (sessionId) {
    scopes.add(sessionId);
    return scopes;
  }
  scopes.add(cwd);
  for (const rt of runtimeScopes) {
    if (rt.cwd === cwd) scopes.add(rt.key);
  }
  return scopes;
}

export interface AsyncCompletionDeps {
  /** Task store to mutate (project + persist completions). */
  store: TaskStore;
  /** True if the completion should be persisted as a session event for this scope. */
  shouldPersist: (scope: string) => boolean;
  /** Emit the run-finished event for a closed-out task. */
  emitFinished: (scope: string, taskId: string, status: TaskRunStatus) => void;
}

export interface ApplyAsyncCompletionOptions {
  /** Event-name string used as the evidence `source`. Defaults to the async-complete event. */
  eventName?: string;
}

/**
 * Apply an async-completion payload to every matching in_progress task in the
 * given scopes. For each task it records the terminal run (optionally guarded
 * by `store.withoutAppending` when the scope is not the active one), then emits
 * the run-finished event. Returns the set of scopes that had at least one task
 * updated, so the caller can refresh the affected UIs without re-scanning.
 *
 * Behaviorally identical to the prior inline handler: idempotent re-runs are
 * safe (only in_progress tasks are touched), and the failed/cancelled summary
 * is recorded as the run error.
 */
export function applyAsyncCompletion(
  data: AsyncCompleteResult,
  scopes: Set<string>,
  deps: AsyncCompletionDeps,
  options: ApplyAsyncCompletionOptions = {},
): Set<string> {
  const ids = new Set(
    [stringField(data, "id"), stringField(data, "asyncId"), stringField(data, "runId")].filter(
      (id): id is string => typeof id === "string",
    ),
  );
  if (ids.size === 0) return new Set();

  const status = asyncCompletionStatus(data);
  const summary = asyncCompletionSummary(data);
  const source = options.eventName ?? SUBAGENT_ASYNC_COMPLETE_EVENT;
  const handled = new Set<string>();

  for (const scope of scopes) {
    // Snapshot the task list once per scope: completeRun mutates the store, so
    // iterating a fresh readAll avoids skipping/rewalking entries.
    const tasks = deps.store.readAll(scope);
    for (const task of tasks) {
      if (!taskMatchesAsyncCompletion(task, ids)) continue;
      if (task.status !== "in_progress") continue;
      const applyCompletion = () =>
        deps.store.completeRun(scope, task.id, status, {
          summary,
          error: status === "failed" || status === "cancelled" ? summary : undefined,
          subagent: task.run ? asyncSubagentRef(data, task.run.subagent) : undefined,
          evidenceMetadata: {
            source,
            asyncId: stringField(data, "id") ?? stringField(data, "asyncId"),
            runId: stringField(data, "runId"),
          },
        });
      const updated = deps.shouldPersist(scope) ? applyCompletion() : deps.store.withoutAppending(applyCompletion);
      deps.emitFinished(scope, updated.id, status);
      handled.add(scope);
    }
  }
  return handled;
}

/** Re-exported so callers building the finished event keep the name in sync. */
export { TASK_RUN_FINISHED_EVENT };
