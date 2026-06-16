import test from "node:test";
import assert from "node:assert/strict";
import { TASK_CLEARED_EVENT, TASK_CREATED_EVENT, TASK_EVIDENCE_RECORDED_EVENT, TASK_RUN_FINISHED_EVENT, TASK_RUN_STARTED_EVENT, TASK_UPDATED_EVENT } from "../../src/extension/src/events.ts";
import { createTask, projectTasksFromEvents, readyTasks, type TaskRunRecord } from "../../src/extension/src/task-state.ts";

test("projects created tasks and ready dependency order", () => {
  const first = createTask({ title: "Setup", prompt: "Do setup" }, "1");
  const second = createTask({ title: "Use setup", prompt: "Do follow-up", blockedBy: ["1"] }, "2");
  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task: first }, ts: "2026-01-01T00:00:00.000Z" },
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "2", task: second }, ts: "2026-01-01T00:00:01.000Z" },
  ]);

  assert.equal(tasks.length, 2);
  assert.deepEqual(readyTasks(tasks).map((task) => task.id), ["1"]);
});

test("run events move task to in_progress then completed", () => {
  const task = createTask({ title: "Implement", prompt: "Patch code" }, "1");
  const run: TaskRunRecord = {
    id: "run-1",
    taskId: "1",
    status: "running",
    agent: "worker",
    startedAt: "2026-01-01T00:00:01.000Z",
    subagent: { agent: "worker", sessionFiles: [], savedOutputs: [], artifactOutputs: [] },
  };

  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task }, ts: "2026-01-01T00:00:00.000Z" },
    { type: "custom", customType: TASK_RUN_STARTED_EVENT, data: { taskId: "1", run }, ts: "2026-01-01T00:00:01.000Z" },
    { type: "custom", customType: TASK_RUN_FINISHED_EVENT, data: { taskId: "1", status: "completed", summary: "done" }, ts: "2026-01-01T00:00:02.000Z" },
  ]);

  assert.equal(tasks[0]?.status, "completed");
  assert.equal(tasks[0]?.run?.status, "completed");
  assert.equal(tasks[0]?.run?.summary, "done");
});

test("run-finished preserves existing subagent metadata when patch omits fields", () => {
  const task = createTask({ title: "Async", prompt: "Run async" }, "1");
  const run: TaskRunRecord = {
    id: "run-1",
    taskId: "1",
    status: "detached",
    agent: "worker",
    startedAt: "2026-01-01T00:00:01.000Z",
    subagent: {
      requestId: "req-1",
      runId: "async-1",
      asyncId: "async-1",
      asyncDir: "/tmp/async-1",
      agent: "worker",
      sessionFiles: ["/tmp/session.jsonl"],
      savedOutputs: ["/tmp/output.md"],
      artifactOutputs: ["/tmp/artifact.md"],
    },
  };

  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task } },
    { type: "custom", customType: TASK_RUN_STARTED_EVENT, data: { taskId: "1", run } },
    { type: "custom", customType: TASK_RUN_FINISHED_EVENT, data: { taskId: "1", status: "completed", summary: "done", subagent: { sessionFiles: [], savedOutputs: [], artifactOutputs: [] } } },
  ]);

  assert.equal(tasks[0]?.run?.subagent.asyncId, "async-1");
  assert.deepEqual(tasks[0]?.run?.subagent.sessionFiles, ["/tmp/session.jsonl"]);
  assert.deepEqual(tasks[0]?.run?.subagent.savedOutputs, ["/tmp/output.md"]);
  assert.deepEqual(tasks[0]?.run?.subagent.artifactOutputs, ["/tmp/artifact.md"]);
});

test("orphan run-finished still records terminal task state", () => {
  const task = createTask({ title: "Finish", prompt: "Finish without started event" }, "1");
  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task } },
    { type: "custom", customType: TASK_RUN_FINISHED_EVENT, data: { taskId: "1", status: "completed", summary: "done" }, ts: "2026-01-01T00:00:02.000Z" },
  ]);

  assert.equal(tasks[0]?.status, "completed");
  assert.equal(tasks[0]?.run?.status, "completed");
  assert.equal(tasks[0]?.run?.summary, "done");
});

test("invalid run-finished status is normalized to failed", () => {
  const task = createTask({ title: "Invalid", prompt: "Invalid status" }, "1");
  const run: TaskRunRecord = {
    id: "run-1",
    taskId: "1",
    status: "running",
    agent: "worker",
    startedAt: "2026-01-01T00:00:01.000Z",
    subagent: { agent: "worker", sessionFiles: [], savedOutputs: [], artifactOutputs: [] },
  };

  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task } },
    { type: "custom", customType: TASK_RUN_STARTED_EVENT, data: { taskId: "1", run } },
    { type: "custom", customType: TASK_RUN_FINISHED_EVENT, data: { taskId: "1", status: "bogus" } },
  ]);

  assert.equal(tasks[0]?.status, "failed");
  assert.equal(tasks[0]?.run?.status, "failed");
});

test("evidence replay replaces duplicate evidence ids", () => {
  const task = createTask({ title: "Evidence", prompt: "Record proof" }, "1");
  const first = { id: "ev-1", kind: "note" as const, text: "old", ts: "2026-01-01T00:00:01.000Z" };
  const second = { ...first, text: "new" };

  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task } },
    { type: "custom", customType: TASK_EVIDENCE_RECORDED_EVENT, data: { taskId: "1", evidence: first } },
    { type: "custom", customType: TASK_EVIDENCE_RECORDED_EVENT, data: { taskId: "1", evidence: second } },
  ]);

  assert.deepEqual(tasks[0]?.evidence.map((e) => e.text), ["new"]);
});

test("patch update events apply to existing tasks", () => {
  const task = createTask({ title: "Patch", prompt: "Patch me" }, "1");
  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task } },
    { type: "custom", customType: TASK_UPDATED_EVENT, data: { taskId: "1", patch: { status: "completed", title: "Patched" } } },
  ]);

  assert.equal(tasks[0]?.status, "completed");
  assert.equal(tasks[0]?.title, "Patched");
});

test("future-version events are ignored during replay", () => {
  const task = createTask({ title: "Future", prompt: "Unknown schema" }, "1");
  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { version: 999, taskId: "1", task } },
  ]);

  assert.deepEqual(tasks, []);
});

test("clear completed keeps open tasks", () => {
  const done = { ...createTask({ title: "Done", prompt: "Done" }, "1"), status: "completed" as const };
  const open = createTask({ title: "Open", prompt: "Open" }, "2");
  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task: done } },
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "2", task: open } },
    { type: "custom", customType: TASK_CLEARED_EVENT, data: { scope: "completed" } },
  ]);

  assert.deepEqual(tasks.map((task) => task.id), ["2"]);
});

test("clear all removes every task", () => {
  const first = createTask({ title: "First", prompt: "One" }, "1");
  const second = createTask({ title: "Second", prompt: "Two" }, "2");
  const tasks = projectTasksFromEvents([
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task: first } },
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "2", task: second } },
    { type: "custom", customType: TASK_CLEARED_EVENT, data: { scope: "all" } },
  ]);

  assert.deepEqual(tasks, []);
});
