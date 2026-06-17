// Regression for the structural-sharing invariant introduced in Phase C-7.
// applyTaskEventToMap now shares untouched task references between the prior
// map and the returned map instead of deep-cloning the whole map per event.
// These tests pin the contract that makes that safe: callers must never be able
// to corrupt canonical projection by mutating a returned task, and projecting a
// prefix of an event log must be unaffected by events that come after it
// (deletes/clears must not mutate tasks shared with an earlier projection).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectTasksFromEvents, applyTaskEventToMap, type TaskEvent } from "../../src/extension/src/task-state.ts";
import {
  TASK_CLEARED_EVENT,
  TASK_CREATED_EVENT,
  TASK_DELETED_EVENT,
  TASK_UPDATED_EVENT,
} from "../../src/extension/src/events.ts";

function created(id: string, over: Partial<{ blocks: string[]; blockedBy: string[]; status: string }> = {}): TaskEvent {
  return {
    type: "custom",
    customType: TASK_CREATED_EVENT,
    data: {
      version: 1,
      taskId: id,
      task: {
        id,
        title: `T${id}`,
        prompt: "p",
        status: (over.status as "pending") ?? "pending",
        kind: "subagent",
        source: "agent",
        blockedBy: over.blockedBy ?? [],
        blocks: over.blocks ?? [],
        metadata: {},
        evidence: [],
        createdAt: "t",
        updatedAt: "t",
      },
    },
    ts: "t",
  };
}
function updated(id: string, patch: Record<string, unknown>): TaskEvent {
  return { type: "custom", customType: TASK_UPDATED_EVENT, data: { version: 1, taskId: id, patch }, ts: "t" };
}
function deleted(id: string): TaskEvent {
  return { type: "custom", customType: TASK_DELETED_EVENT, data: { version: 1, taskId: id }, ts: "t" };
}
function cleared(scope: "all" | "completed" = "completed"): TaskEvent {
  return { type: "custom", customType: TASK_CLEARED_EVENT, data: { version: 1, scope }, ts: "t" };
}

describe("structural sharing — aliasing safety", () => {
  it("mutating a task returned by projection does not corrupt a fresh projection", () => {
    const events = [created("1"), created("2")];
    const first = projectTasksFromEvents(events);
    // Caller mutates a returned task object directly (should be impossible to
    // corrupt canonical state because projection returns owned copies).
    first[0].title = "MUTATED";
    first[0].blocks.push("999");
    const second = projectTasksFromEvents(events);
    assert.equal(second.find((t) => t.id === "1")?.title, "T1");
    assert.deepEqual(second.find((t) => t.id === "1")?.blocks, []);
  });

  it("applying an event to a map does not mutate the input map (callers can keep their snapshot)", () => {
    const seed = projectTasksFromEvents([created("1"), created("2")]);
    const seedMap = new Map(seed.map((t) => [t.id, t]));
    const before = seedMap.get("1")!;
    applyTaskEventToMap(seedMap, updated("1", { owner: "x" }));
    // The input map's entry must be untouched (applyTaskEventToMap returns a new
    // map rather than mutating in place).
    assert.equal(before.owner, undefined);
    assert.equal(seedMap.get("1")!, before);
  });

  it("a DELETE does not corrupt tasks shared with a shorter projection", () => {
    // Projection B includes a delete of "1"; projection A is the prefix without it.
    const prefix = [created("1"), created("2", { blockedBy: ["1"] })];
    const full = [...prefix, deleted("1")];

    const projectionA = projectTasksFromEvents(prefix);
    const projectionB = projectTasksFromEvents(full);

    // Full projection stripped the reciprocal blockedBy edge…
    assert.deepEqual(projectionB.find((t) => t.id === "2")?.blockedBy, []);
    assert.equal(projectionB.find((t) => t.id === "1"), undefined);
    // …but the prefix projection must still see the original edge. If the DELETE
    // branch mutated the shared "2" reference in place, this would be [].
    assert.deepEqual(projectionA.find((t) => t.id === "2")?.blockedBy, ["1"]);
    assert.equal(projectionA.find((t) => t.id === "1")?.status, "pending");
  });

  it("a CLEAR(completed) does not corrupt tasks shared with a shorter projection", () => {
    const prefix = [
      created("1"),
      created("2", { blocks: ["1"] }),
      updated("1", { status: "completed" }), // mark 1 completed
    ];
    const full = [...prefix, cleared("completed")];

    const projectionA = projectTasksFromEvents(prefix);
    const projectionB = projectTasksFromEvents(full);

    assert.equal(projectionB.find((t) => t.id === "1"), undefined);
    assert.deepEqual(projectionB.find((t) => t.id === "2")?.blocks, []);
    // Prefix must be unaffected by the clear that came after it.
    assert.equal(projectionA.find((t) => t.id === "1")?.status, "completed");
    assert.deepEqual(projectionA.find((t) => t.id === "2")?.blocks, ["1"]);
  });

  it("CLEAR(all) leaves a prefix projection intact", () => {
    const prefix = [created("1"), created("2", { blockedBy: ["1"] })];
    const full = [...prefix, cleared("all")];
    const projectionA = projectTasksFromEvents(prefix);
    const projectionB = projectTasksFromEvents(full);
    assert.equal(projectionB.length, 0);
    assert.equal(projectionA.length, 2);
    assert.deepEqual(projectionA.find((t) => t.id === "2")?.blockedBy, ["1"]);
  });
});
