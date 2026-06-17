import test from "node:test";
import assert from "node:assert/strict";
import { asyncCompletionStatus, asyncCompletionSummary, asyncSubagentRef, stringField, taskMatchesAsyncCompletion } from "../../src/extension/src/async-completion.ts";
import { createTask, type TaskItem, type TaskRunRecord } from "../../src/extension/src/task-state.ts";

function taskWithRun(taskId: string, asyncId?: string): TaskItem {
  const task = createTask({ title: "T", prompt: "p" }, taskId);
  const run: TaskRunRecord = {
    id: `run-${taskId}`,
    taskId,
    status: "running",
    agent: "worker",
    startedAt: "2026-01-01T00:00:00.000Z",
    subagent: {
      agent: "worker",
      asyncId,
      runId: asyncId,
      sessionFiles: ["/keep.jsonl"],
      savedOutputs: ["/keep.md"],
      artifactOutputs: [],
    },
  };
  task.run = run;
  task.owner = "owner-1";
  return task;
}

test("stringField returns non-empty strings and drops everything else", () => {
  assert.equal(stringField({ k: "v" }, "k"), "v");
  assert.equal(stringField({ k: "" }, "k"), undefined);
  assert.equal(stringField({ k: 7 }, "k"), undefined);
  assert.equal(stringField({}, "k"), undefined);
});

test("asyncCompletionStatus maps the payload status vocabulary via regex", () => {
  assert.equal(asyncCompletionStatus({ success: false }), "failed");
  assert.equal(asyncCompletionStatus({ status: "failed" }), "failed");
  assert.equal(asyncCompletionStatus({ state: "error" }), "failed");
  assert.equal(asyncCompletionStatus({ state: "canceled" }), "cancelled");
  assert.equal(asyncCompletionStatus({ status: "interrupted-by-user" }), "cancelled");
  assert.equal(asyncCompletionStatus({ status: "completed" }), "completed");
  assert.equal(asyncCompletionStatus({}), "completed");
});

test("asyncCompletionStatus inspects nested results[].status", () => {
  assert.equal(asyncCompletionStatus({ results: [{ status: "error" }] }), "failed");
  assert.equal(asyncCompletionStatus({ results: [{ status: "killed" }] }), "cancelled");
  assert.equal(asyncCompletionStatus({ results: [{ status: "ok" }] }), "completed");
});

test("asyncCompletionSummary prefers direct fields then falls back to per-result outputs", () => {
  assert.equal(asyncCompletionSummary({ summary: "direct" }), "direct");
  assert.equal(asyncCompletionSummary({ error: "boom" }), "boom");
  assert.equal(
    asyncCompletionSummary({ results: [{ finalOutput: "a" }, { finalOutput: "b" }] }),
    "a\n\nb",
  );
  assert.equal(asyncCompletionSummary({}), "Async subagent run completed.");
});

test("taskMatchesAsyncCompletion matches any recorded id or owner", () => {
  const task = taskWithRun("1", "async-1");
  assert.equal(taskMatchesAsyncCompletion(task, new Set(["async-1"])), true);
  assert.equal(taskMatchesAsyncCompletion(task, new Set(["run-1"])), true);
  assert.equal(taskMatchesAsyncCompletion(task, new Set(["owner-1"])), true);
  assert.equal(taskMatchesAsyncCompletion(task, new Set(["other"])), false);
});

test("taskMatchesAsyncCompletion is false for a task with no run subagent", () => {
  const task = createTask({ title: "T", prompt: "p" }, "1");
  assert.equal(taskMatchesAsyncCompletion(task, new Set(["1"])), false);
});

test("asyncSubagentRef merges ids and unions file lists without duplicates", () => {
  const task = taskWithRun("1", "async-1");
  const merged = asyncSubagentRef(
    {
      id: "async-1",
      asyncDir: "/tmp/new",
      runId: "run-new",
      results: [
        { savedOutputPath: "/keep.md", sessionFile: "/new.jsonl", artifactPath: "/art.md", savedOutput: "/extra.md" },
      ],
    },
    task.run!.subagent,
  );
  assert.equal(merged.asyncId, "async-1");
  assert.equal(merged.asyncDir, "/tmp/new");
  assert.equal(merged.runId, "run-new");
  // /keep.md appears in both current and payload → deduped to one entry.
  assert.deepEqual(merged.savedOutputs, ["/keep.md", "/extra.md"]);
  assert.deepEqual(merged.sessionFiles, ["/keep.jsonl", "/new.jsonl"]);
  assert.deepEqual(merged.artifactOutputs, ["/art.md"]);
});
