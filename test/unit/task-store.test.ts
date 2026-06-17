import test from "node:test";
import assert from "node:assert/strict";
import { taskStore, type TaskEvent } from "../../src/extension/src/task-store.ts";

test("taskStore appends events and maintains reciprocal dependencies", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  const one = taskStore.createTask("/repo", { title: "First", prompt: "Do first" });
  const two = taskStore.createTask("/repo", { title: "Second", prompt: "Do second", blockedBy: [one.id] });

  assert.equal(one.id, "1");
  assert.equal(two.id, "2");
  assert.deepEqual(taskStore.readTask("/repo", one.id)?.blocks, [two.id]);
  assert.deepEqual(taskStore.ready("/repo").map((task) => task.id), [one.id]);
  assert.ok(events.length >= 3, "create + reciprocal update events are appended");
});

test("taskStore composes reciprocal dependency changes for the same target", () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});

  const first = taskStore.createTask("/repo", { title: "First", prompt: "Do first" });
  const second = taskStore.createTask("/repo", { title: "Second", prompt: "Do second" });

  taskStore.updateTask("/repo", first.id, { blocks: [second.id] });
  taskStore.updateTask("/repo", first.id, { blockedBy: [second.id], blocks: [] });

  assert.deepEqual(taskStore.readTask("/repo", second.id)?.blockedBy, []);
  assert.deepEqual(taskStore.readTask("/repo", second.id)?.blocks, [first.id]);
});

test("taskStore delete removes reciprocal dependency edges", () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});

  const first = taskStore.createTask("/repo", { title: "First", prompt: "Do first" });
  const second = taskStore.createTask("/repo", { title: "Second", prompt: "Do second", blockedBy: [first.id] });

  taskStore.deleteTask("/repo", first.id);

  assert.equal(taskStore.readTask("/repo", first.id), null);
  assert.deepEqual(taskStore.readTask("/repo", second.id)?.blockedBy, []);
});

test("taskStore events include a schema version and snapshot compacts current projection", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  const task = taskStore.createTask("/repo", { title: "Snapshot", prompt: "Keep me" });
  const count = taskStore.snapshot("/repo");

  assert.equal(count, 1);
  assert.equal(events[0]?.data?.version, 1);
  assert.equal(events.at(-1)?.customType, "pi-tasks:snapshot");
  taskStore.reset();
  taskStore.applyEvents("/repo", [events.at(-1)!]);
  assert.deepEqual(taskStore.readAll("/repo").map((item) => item.id), [task.id]);
});

test("taskStore reconstructs from captured events", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  const task = taskStore.createTask("/repo", { title: "Build", prompt: "Build it" });
  taskStore.updateStatus("/repo", task.id, "completed", "proof passed");

  taskStore.reset();
  taskStore.applyEvents("/repo", events);

  const restored = taskStore.readTask("/repo", task.id);
  assert.equal(restored?.status, "completed");
  assert.equal(restored?.evidence.at(-1)?.text, "proof passed");
});

test("taskStore preserves high-water ids after delete and clear", () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});

  const first = taskStore.createTask("/repo", { title: "First", prompt: "One" });
  taskStore.deleteTask("/repo", first.id);
  const second = taskStore.createTask("/repo", { title: "Second", prompt: "Two" });
  assert.equal(second.id, "2");

  taskStore.clearAll("/repo");
  const third = taskStore.createTask("/repo", { title: "Third", prompt: "Three" });
  assert.equal(third.id, "3");
});

test("taskStore preserves high-water ids across replay", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  const first = taskStore.createTask("/repo", { title: "First", prompt: "One" });
  taskStore.clearAll("/repo");
  assert.equal(first.id, "1");

  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  taskStore.applyEvents("/repo", events);
  const second = taskStore.createTask("/repo", { title: "Second", prompt: "Two" });

  assert.equal(second.id, "2");
});

test("taskStore snapshot carries high-water id through empty compaction", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  taskStore.createTask("/repo", { title: "First", prompt: "One" });
  taskStore.clearAll("/repo");
  taskStore.snapshot("/repo");
  const snapshot = events.at(-1)!;
  assert.equal(snapshot.customType, "pi-tasks:snapshot");
  assert.equal(snapshot.data?.highWaterId, "1");

  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  taskStore.applyEvents("/repo", [snapshot]);
  const second = taskStore.createTask("/repo", { title: "Second", prompt: "Two" });

  assert.equal(second.id, "2");
});

test("taskStore ignores future-version events for high-water ids", () => {
  taskStore.reset();
  taskStore.applyEvents("/repo", [
    { type: "custom", customType: "pi-tasks:created", data: { version: 999, taskId: "42", task: { id: "42" } } },
  ]);
  taskStore.setEventAppender(() => {});

  const task = taskStore.createTask("/repo", { title: "First", prompt: "One" });

  assert.equal(task.id, "1");
});

test("taskStore.claimTask sets owner and appends an updated event", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  const task = taskStore.createTask("/repo", { title: "Claim", prompt: "Work" });
  const result = taskStore.claimTask("/repo", task.id, { owner: "alice" });

  assert.equal(result.success, true);
  assert.equal(result.task?.owner, "alice");
  assert.equal(taskStore.readTask("/repo", task.id)?.owner, "alice");
  assert.equal(taskStore.readTask("/repo", task.id)?.status, "pending");
  assert.ok(events.some((e) => e.customType === "pi-tasks:updated"));
});

test("taskStore.claimTask with start sets status to in_progress", () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});

  const task = taskStore.createTask("/repo", { title: "Claim", prompt: "Work" });
  const result = taskStore.claimTask("/repo", task.id, { owner: "alice", start: true });

  assert.equal(result.success, true);
  assert.equal(result.task?.status, "in_progress");
  assert.equal(taskStore.readTask("/repo", task.id)?.status, "in_progress");
});

test("taskStore.claimTask trims owners and rejects blank owners without mutating", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  const task = taskStore.createTask("/repo", { title: "Claim", prompt: "Work" });
  const eventCount = events.length;
  const blank = taskStore.claimTask("/repo", task.id, { owner: "   " });
  assert.equal(blank.success, false);
  assert.equal(blank.reason, "invalid_owner");
  assert.equal(taskStore.readTask("/repo", task.id)?.owner, undefined);
  assert.equal(events.length, eventCount);

  const trimmed = taskStore.claimTask("/repo", task.id, { owner: "  alice  " });
  assert.equal(trimmed.success, true);
  assert.equal(trimmed.task?.owner, "alice");
  assert.equal(taskStore.readTask("/repo", task.id)?.owner, "alice");
});

test("taskStore.claimTask does not mutate on failure", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));

  const task = taskStore.createTask("/repo", { title: "Claim", prompt: "Work" });
  const initialEventCount = events.length;
  const result = taskStore.claimTask("/repo", "999", { owner: "alice" });

  assert.equal(result.success, false);
  assert.equal(result.reason, "task_not_found");
  assert.equal(events.length, initialEventCount);
  assert.equal(taskStore.readTask("/repo", task.id)?.owner, undefined);
});

test("taskStore.claimTask respects blocked dependencies", () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});

  const blocker = taskStore.createTask("/repo", { title: "Blocker", prompt: "First" });
  const target = taskStore.createTask("/repo", { title: "Target", prompt: "Second", blockedBy: [blocker.id] });
  const result = taskStore.claimTask("/repo", target.id, { owner: "alice" });

  assert.equal(result.success, false);
  assert.equal(result.reason, "blocked");
  assert.deepEqual(result.blockedByTasks, [blocker.id]);
  assert.equal(taskStore.readTask("/repo", target.id)?.owner, undefined);
});

test("taskStore.claimTask enforces one_open_per_owner", () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});

  const open = taskStore.createTask("/repo", { title: "Open", prompt: "In progress" });
  taskStore.claimTask("/repo", open.id, { owner: "alice", start: true });
  const target = taskStore.createTask("/repo", { title: "Target", prompt: "Claim me" });
  const result = taskStore.claimTask("/repo", target.id, { owner: "alice", oneOpenPerOwner: true });

  assert.equal(result.success, false);
  assert.equal(result.reason, "owner_busy");
  assert.deepEqual(result.busyWithTasks, [open.id]);
  assert.equal(taskStore.readTask("/repo", target.id)?.owner, undefined);
});

test("taskStore.claimTask preserves existing TaskUpdate owner behavior", () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});

  const task = taskStore.createTask("/repo", { title: "Owned", prompt: "Work" });
  // TaskUpdate owner is a direct assignment — no precondition checks.
  taskStore.updateTask("/repo", task.id, { owner: "bob" });
  assert.equal(taskStore.readTask("/repo", task.id)?.owner, "bob");

  // claimTask without force refuses to overwrite bob.
  const claimResult = taskStore.claimTask("/repo", task.id, { owner: "alice" });
  assert.equal(claimResult.success, false);
  assert.equal(claimResult.reason, "already_claimed");
  assert.equal(taskStore.readTask("/repo", task.id)?.owner, "bob");
});
