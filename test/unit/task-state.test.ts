import test from "node:test";
import assert from "node:assert/strict";
import { TASK_CLEARED_EVENT, TASK_CREATED_EVENT, TASK_EVIDENCE_RECORDED_EVENT, TASK_RUN_FINISHED_EVENT, TASK_RUN_STARTED_EVENT, TASK_SNAPSHOT_EVENT, TASK_STATUS_UPDATED_EVENT, TASK_UPDATED_EVENT } from "../../src/extension/src/events.ts";
import { createTask, evaluateClaim, filterVisible, isInternal, projectTasksFromEvents, readyTasks, type TaskRunRecord } from "../../src/extension/src/task-state.ts";

test("snapshot anchors state so dropped earlier events survive compaction-style replay", () => {
  // Simulate a pre-compaction branch: create 1, 2, 3; advance 1 to in_progress.
  const task1 = createTask({ title: "Setup", prompt: "Do setup" }, "1");
  const task2 = createTask({ title: "Build", prompt: "Do build" }, "2");
  const task3 = createTask({ title: "Ship", prompt: "Do ship" }, "3");
  const fullBranch = [
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task: task1 }, ts: "2026-01-01T00:00:00.000Z" },
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "2", task: task2 }, ts: "2026-01-01T00:00:01.000Z" },
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "3", task: task3 }, ts: "2026-01-01T00:00:02.000Z" },
    { type: "custom", customType: TASK_STATUS_UPDATED_EVENT, data: { taskId: "1", status: "in_progress" }, ts: "2026-01-01T00:00:03.000Z" },
  ];
  // The compaction handler appends a snapshot capturing full state at the tail.
  const snapshotTasks = projectTasksFromEvents(fullBranch).map((task) => ({ ...task }));
  const snapshotEvent = { type: "custom", customType: TASK_SNAPSHOT_EVENT, data: { tasks: snapshotTasks }, ts: "2026-01-01T00:00:04.000Z" };
  // A post-snapshot task created in the next turn.
  const task4 = createTask({ title: "Doc", prompt: "Write docs" }, "4");
  const postSnapshot = { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "4", task: task4 }, ts: "2026-01-01T00:00:05.000Z" };

  // Post-compaction replay: summarized span (creates + status) removed;
  // only [snapshot, post-snapshot create] survive.
  const rebuilt = projectTasksFromEvents([snapshotEvent, postSnapshot]);

  assert.equal(rebuilt.length, 4);
  const byId = new Map(rebuilt.map((task) => [task.id, task]));
  assert.equal(byId.get("1")?.status, "in_progress");
  assert.equal(byId.get("2")?.status, "pending");
  assert.equal(byId.get("3")?.status, "pending");
  assert.equal(byId.get("4")?.status, "pending");
});

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

test("evaluateClaim succeeds for a pending unowned task", () => {
  const task = createTask({ title: "Claim me", prompt: "Work" }, "1");
  const result = evaluateClaim(task, [task], { owner: "alice" });
  assert.equal(result.success, true);
  assert.equal(result.task?.id, "1");
  assert.equal(result.reason, undefined);
});

test("evaluateClaim returns task_not_found for a null task", () => {
  const result = evaluateClaim(null, [], { owner: "alice" });
  assert.equal(result.success, false);
  assert.equal(result.reason, "task_not_found");
});

test("evaluateClaim rejects blank owners", () => {
  const task = createTask({ title: "Claim me", prompt: "Work" }, "1");
  for (const owner of ["", "   "]) {
    const result = evaluateClaim(task, [task], { owner });
    assert.equal(result.success, false);
    assert.equal(result.reason, "invalid_owner");
  }
});

test("evaluateClaim returns already_terminal for completed, failed, and cancelled tasks", () => {
  const base = createTask({ title: "Done", prompt: "Finished" }, "1");
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const task = { ...base, status };
    const result = evaluateClaim(task, [task], { owner: "alice" });
    assert.equal(result.success, false);
    assert.equal(result.reason, "already_terminal");
  }
});

test("evaluateClaim returns already_claimed when another owner holds the task", () => {
  const task = { ...createTask({ title: "Owned", prompt: "Work" }, "1"), owner: "bob" };
  const result = evaluateClaim(task, [task], { owner: "alice" });
  assert.equal(result.success, false);
  assert.equal(result.reason, "already_claimed");
  assert.equal(result.task?.owner, "bob");
});

test("evaluateClaim force overrides already_claimed", () => {
  const task = { ...createTask({ title: "Owned", prompt: "Work" }, "1"), owner: "bob" };
  const result = evaluateClaim(task, [task], { owner: "alice", force: true });
  assert.equal(result.success, true);
});

test("evaluateClaim allows the same owner to re-claim", () => {
  const task = { ...createTask({ title: "Mine", prompt: "Work" }, "1"), owner: "alice" };
  const result = evaluateClaim(task, [task], { owner: "alice" });
  assert.equal(result.success, true);
});

test("evaluateClaim returns blocked with unresolved dependency ids", () => {
  const blocker = createTask({ title: "Blocker", prompt: "First" }, "1");
  const target = createTask({ title: "Target", prompt: "Second", blockedBy: ["1"] }, "2");
  const result = evaluateClaim(target, [blocker, target], { owner: "alice" });
  assert.equal(result.success, false);
  assert.equal(result.reason, "blocked");
  assert.deepEqual(result.blockedByTasks, ["1"]);
});

test("evaluateClaim blocked clears when dependency completes", () => {
  const blocker = { ...createTask({ title: "Blocker", prompt: "First" }, "1"), status: "completed" as const };
  const target = createTask({ title: "Target", prompt: "Second", blockedBy: ["1"] }, "2");
  const result = evaluateClaim(target, [blocker, target], { owner: "alice" });
  assert.equal(result.success, true);
});

test("evaluateClaim returns owner_busy when one_open_per_owner is set and owner has open work", () => {
  const open = { ...createTask({ title: "Open", prompt: "In progress" }, "1"), owner: "alice", status: "in_progress" as const };
  const target = createTask({ title: "Target", prompt: "Claim me" }, "2");
  const result = evaluateClaim(target, [open, target], { owner: "alice", oneOpenPerOwner: true });
  assert.equal(result.success, false);
  assert.equal(result.reason, "owner_busy");
  assert.deepEqual(result.busyWithTasks, ["1"]);
});

test("evaluateClaim owner_busy does not count terminal tasks owned by the owner", () => {
  const done = { ...createTask({ title: "Done", prompt: "Finished" }, "1"), owner: "alice", status: "completed" as const };
  const target = createTask({ title: "Target", prompt: "Claim me" }, "2");
  const result = evaluateClaim(target, [done, target], { owner: "alice", oneOpenPerOwner: true });
  assert.equal(result.success, true);
});

test("evaluateClaim force overrides owner_busy but not terminal or blocked", () => {
  const open = { ...createTask({ title: "Open", prompt: "In progress" }, "1"), owner: "alice", status: "in_progress" as const };
  const target = createTask({ title: "Target", prompt: "Claim me" }, "2");
  const result = evaluateClaim(target, [open, target], { owner: "alice", oneOpenPerOwner: true, force: true });
  assert.equal(result.success, true);

  const terminal = { ...createTask({ title: "Done", prompt: "Done" }, "3"), status: "completed" as const };
  const forceTerminal = evaluateClaim(terminal, [terminal], { owner: "alice", force: true });
  assert.equal(forceTerminal.success, false);
  assert.equal(forceTerminal.reason, "already_terminal");
});

test("isInternal reflects the metadata._internal bookkeeping flag", () => {
  assert.equal(isInternal(createTask({ title: "A", prompt: "p" }, "1")), false);
  assert.equal(isInternal({ ...createTask({ title: "A", prompt: "p" }, "1"), metadata: { _internal: true } }), true);
  assert.equal(isInternal({ ...createTask({ title: "A", prompt: "p" }, "1"), metadata: { _internal: 1 } }), true);
  assert.equal(isInternal({ ...createTask({ title: "A", prompt: "p" }, "1"), metadata: { _internal: false } }), false);
});

test("filterVisible drops internal tasks but keeps the rest", () => {
  const visible = createTask({ title: "Visible", prompt: "p" }, "1");
  const internal = { ...createTask({ title: "Internal", prompt: "p" }, "2"), metadata: { _internal: true } };
  assert.deepEqual(filterVisible([visible, internal]).map((task) => task.id), ["1"]);
});
