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
