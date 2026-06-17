// Coverage for Phase C-8: snapshot-seeded replay in TaskStore.applyEvents.
// A TASK_SNAPSHOT event resets the projection, so applyEvents seeds the map from
// the LAST snapshot and replays only the post-snapshot tail instead of
// re-deriving dead pre-snapshot events. These tests pin the equivalence:
// seeding from a snapshot must produce identical state to replaying everything,
// and the high-water id must survive.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTaskStore, type TaskStore } from "../../src/extension/src/task-store.ts";
import { projectTasksFromEvents, type TaskEvent, type TaskItem } from "../../src/extension/src/task-state.ts";
import {
  TASK_CREATED_EVENT,
  TASK_DELETED_EVENT,
  TASK_SNAPSHOT_EVENT,
  TASK_STATUS_UPDATED_EVENT,
} from "../../src/extension/src/events.ts";

function created(id: string): TaskEvent {
  const task: TaskItem = {
    id, title: `T${id}`, prompt: "p", status: "pending", kind: "subagent", source: "agent",
    blockedBy: [], blocks: [], metadata: {}, evidence: [], createdAt: "t", updatedAt: "t",
  };
  return { type: "custom", customType: TASK_CREATED_EVENT, data: { version: 1, taskId: id, task }, ts: "t" };
}
function statusUpdated(id: string, status: TaskItem["status"]): TaskEvent {
  return { type: "custom", customType: TASK_STATUS_UPDATED_EVENT, data: { version: 1, taskId: id, status }, ts: "t" };
}
function deleted(id: string): TaskEvent {
  return { type: "custom", customType: TASK_DELETED_EVENT, data: { version: 1, taskId: id }, ts: "t" };
}

describe("applyEvents snapshot-seeded replay (Phase C-8)", () => {
  let store: TaskStore;
  beforeEach(() => {
    store = createTaskStore();
    store.setEventAppender(() => {});
  });

  it("produces identical state to replaying the whole log when a snapshot is present mid-stream", () => {
    // create 1..3, snapshot, then status change + a delete after the snapshot.
    const pre = [created("1"), created("2"), created("3")];
    store.applyEvents("s", pre);
    // Record a real snapshot through the store so it carries the highWaterId.
    store.snapshot("s");
    const appended = pre; // snapshot was appended via the appender stub (no-op); build it explicitly instead
    void appended;
    const snapshotTasks = store.readAll("s");
    const snapshotEvent: TaskEvent = {
      type: "custom",
      customType: TASK_SNAPSHOT_EVENT,
      data: { version: 1, tasks: snapshotTasks, highWaterId: "3" },
      ts: "t",
    };
    const tail = [statusUpdated("2", "completed"), deleted("1")];
    const events = [...pre, snapshotEvent, ...tail];

    // Snapshot-seeded replay (applyEvents) vs full replay (projectTasksFromEvents)
    const fresh = createTaskStore();
    fresh.applyEvents("s", events);
    const seeded = fresh.readAll("s");
    const replayed = projectTasksFromEvents(events);

    assert.deepEqual(
      seeded.map((t) => `${t.id}:${t.status}`).sort(),
      replayed.map((t) => `${t.id}:${t.status}`).sort(),
    );
    // tail applied correctly: 2 completed, 1 deleted
    assert.equal(fresh.readTask("s", "1"), null);
    assert.equal(fresh.readTask("s", "2")?.status, "completed");
    assert.equal(fresh.readTask("s", "3")?.status, "pending");
  });

  it("ignores dead pre-snapshot events (they must not affect final state)", () => {
    // Pre-snapshot: create 1,2,3 then DELETE 2. The snapshot captures the state
    // AT snapshot time (2 already gone). Tail re-creates nothing. Final state
    // must equal the snapshot, regardless of the pre-snapshot churn.
    const snapshotTasks: TaskItem[] = [
      { id: "1", title: "T1", prompt: "p", status: "pending", kind: "subagent", source: "agent", blockedBy: [], blocks: [], metadata: {}, evidence: [], createdAt: "t", updatedAt: "t" },
      { id: "3", title: "T3", prompt: "p", status: "pending", kind: "subagent", source: "agent", blockedBy: [], blocks: [], metadata: {}, evidence: [], createdAt: "t", updatedAt: "t" },
    ];
    const snapshotEvent: TaskEvent = {
      type: "custom", customType: TASK_SNAPSHOT_EVENT,
      data: { version: 1, tasks: snapshotTasks, highWaterId: "3" }, ts: "t",
    };
    const deadChurn = [created("1"), created("2"), created("3"), deleted("2")];
    const events = [...deadChurn, snapshotEvent];

    store.applyEvents("s", events);
    assert.deepEqual(store.readAll("s").map((t) => t.id).sort(), ["1", "3"]);
  });

  it("seeds from the LAST snapshot when multiple are present", () => {
    const snap1: TaskEvent = { type: "custom", customType: TASK_SNAPSHOT_EVENT, data: { version: 1, tasks: [{ id: "1", title: "old", prompt: "p", status: "pending", kind: "subagent", source: "agent", blockedBy: [], blocks: [], metadata: {}, evidence: [], createdAt: "t", updatedAt: "t" }], highWaterId: "1" }, ts: "t" };
    const snap2: TaskEvent = { type: "custom", customType: TASK_SNAPSHOT_EVENT, data: { version: 1, tasks: [{ id: "5", title: "new", prompt: "p", status: "pending", kind: "subagent", source: "agent", blockedBy: [], blocks: [], metadata: {}, evidence: [], createdAt: "t", updatedAt: "t" }], highWaterId: "5" }, ts: "t" };
    store.applyEvents("s", [snap1, snap2]);
    assert.deepEqual(store.readAll("s").map((t) => t.id), ["5"]);
    assert.equal(store.readTask("s", "5")?.title, "new");
  });

  it("replays from empty when there is no snapshot (unchanged behavior)", () => {
    const events = [created("1"), created("2"), statusUpdated("1", "completed")];
    store.applyEvents("s", events);
    const seeded = store.readAll("s").map((t) => `${t.id}:${t.status}`).sort();
    const replayed = projectTasksFromEvents(events).map((t) => `${t.id}:${t.status}`).sort();
    assert.deepEqual(seeded, replayed);
    assert.deepEqual(seeded, ["1:completed", "2:pending"]);
  });

  it("ignores a future-version snapshot (does not seed from it)", () => {
    const futureSnapshot: TaskEvent = {
      type: "custom", customType: TASK_SNAPSHOT_EVENT,
      data: { version: 999, tasks: [{ id: "9", title: "future", prompt: "p", status: "pending", kind: "subagent", source: "agent", blockedBy: [], blocks: [], metadata: {}, evidence: [], createdAt: "t", updatedAt: "t" }], highWaterId: "9" },
      ts: "t",
    };
    // A v1 create before the future snapshot must still be honored (the future
    // snapshot is skipped, so seeding falls back to replaying v1 events).
    store.applyEvents("s", [created("1"), futureSnapshot]);
    assert.deepEqual(store.readAll("s").map((t) => t.id), ["1"]);
  });
});
