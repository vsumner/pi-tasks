// Coverage for the async-completion handler extracted from index.ts (Phase B-2).
// Uses an isolated createTaskStore() fixture so the routing/persistence
// decisions are testable without the global singleton or a live Pi runtime.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applyAsyncCompletion, resolveCompletionScopes, SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/extension/src/async-completion-handler.ts";
import { createTaskStore, type TaskStore } from "../../src/extension/src/task-store.ts";
import type { TaskRunRecord } from "../../src/extension/src/task-state.ts";

// Keep the event-name export referenced even if a focused test run trims others.
void SUBAGENT_ASYNC_COMPLETE_EVENT;

function seedAsyncTask(store: TaskStore, scope: string, asyncId: string, agent = "worker"): string {
  const task = store.createTask(scope, { title: "t", prompt: "p", cwd: "/repo", agent });
  const run: TaskRunRecord = {
    id: `task-${task.id}-${Date.now()}`,
    taskId: task.id,
    status: "running",
    agent,
    startedAt: new Date().toISOString(),
    subagent: { agent, sessionFiles: [], savedOutputs: [], artifactOutputs: [], asyncId },
  };
  store.startRun(scope, task.id, run);
  return task.id;
}

describe("resolveCompletionScopes", () => {
  it("scopes to a single session when sessionId is present", () => {
    const scopes = resolveCompletionScopes("/repo", "session-7", [{ key: "s1", cwd: "/repo" }]);
    assert.deepEqual([...scopes], ["session-7"]);
  });
  it("falls back to cwd plus every runtime sharing that cwd", () => {
    const scopes = resolveCompletionScopes("/repo", undefined, [
      { key: "s1", cwd: "/repo" },
      { key: "s2", cwd: "/other" },
      { key: "s3", cwd: "/repo" },
    ]);
    assert.deepEqual([...scopes].sort(), ["/repo", "s1", "s3"]);
  });
  it("dedupes when cwd and a runtime key collide", () => {
    const scopes = resolveCompletionScopes("session-1", undefined, [{ key: "session-1", cwd: "session-1" }]);
    assert.deepEqual([...scopes], ["session-1"]);
  });
  it("handles empty runtime list", () => {
    const scopes = resolveCompletionScopes("/repo", undefined, []);
    assert.deepEqual([...scopes], ["/repo"]);
  });
  it("ignores runtime cwds when sessionId scopes the completion", () => {
    const scopes = resolveCompletionScopes("/repo", "session-7", [
      { key: "s1", cwd: "/repo" },
      { key: "s2", cwd: "/repo" },
    ]);
    assert.deepEqual([...scopes], ["session-7"]);
  });
});

describe("applyAsyncCompletion", () => {
  let store: TaskStore;
  beforeEach(() => {
    store = createTaskStore();
    // completeRun appends a session event; the isolated store needs an appender
    // or it throws. Default to a no-op; persistence tests override it.
    store.setEventAppender(() => {});
  });

  it("closes out a matching in_progress async task as completed and emits finished", () => {
    const id = seedAsyncTask(store, "s1", "async-1");
    const emitted: Array<{ scope: string; taskId: string; status: string }> = [];
    const handled = applyAsyncCompletion(
      { id: "async-1", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      {
        store,
        shouldPersist: () => true,
        emitFinished: (scope, taskId, status) => emitted.push({ scope, taskId, status }),
      },
    );
    assert.deepEqual([...handled], ["s1"]);
    assert.equal(store.readTask("s1", id)?.status, "completed");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].taskId, id);
    assert.equal(emitted[0].status, "completed");
    assert.ok(store.readTask("s1", id)!.evidence.length > 0, "completion should record evidence");
  });

  it("records the summary as the run error for failed and cancelled status", () => {
    for (const status of ["failed", "cancelled"] as const) {
      const id = seedAsyncTask(store, "s1", `a-${status}`);
      applyAsyncCompletion(
        { id: `a-${status}`, status, summary: "boom", cwd: "/repo" },
        new Set(["s1"]),
        { store, shouldPersist: () => true, emitFinished: () => {} },
      );
      const task = store.readTask("s1", id)!;
      assert.equal(task.status, status);
      assert.equal(task.run?.error, "boom");
    }
  });

  it("matches by runId when asyncId is absent", () => {
    const task = store.createTask("s1", { title: "t", prompt: "p", cwd: "/repo" });
    const run: TaskRunRecord = {
      id: "run-xyz",
      taskId: task.id,
      status: "running",
      agent: "worker",
      startedAt: new Date().toISOString(),
      subagent: { agent: "worker", sessionFiles: [], savedOutputs: [], artifactOutputs: [] },
    };
    store.startRun("s1", task.id, run);
    applyAsyncCompletion(
      { runId: "run-xyz", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
    );
    assert.equal(store.readTask("s1", task.id)?.status, "completed");
  });

  it("suppresses session persistence when shouldPersist is false (but still updates the projection)", () => {
    const id = seedAsyncTask(store, "s1", "async-2");
    const appended: string[] = [];
    store.setEventAppender((event) => appended.push(event.customType ?? event.type));
    const emitted: string[] = [];
    applyAsyncCompletion(
      { id: "async-2", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      {
        store,
        shouldPersist: () => false,
        emitFinished: (_scope, taskId) => emitted.push(taskId),
      },
    );
    // In-memory projection reflects the terminal state so the UI updates…
    assert.equal(store.readTask("s1", id)?.status, "completed");
    // …but no session events were appended (cross-session pollution avoided)
    assert.equal(appended.length, 0, "no session events appended when persistence suppressed");
    assert.deepEqual(emitted, [id], "finished event still emitted to the bridge");
  });

  it("persists run-finished + evidence events when shouldPersist is true", () => {
    const id = seedAsyncTask(store, "s1", "async-2b");
    const appended: string[] = [];
    store.setEventAppender((event) => appended.push(event.customType ?? event.type));
    applyAsyncCompletion(
      { id: "async-2b", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
    );
    assert.equal(store.readTask("s1", id)?.status, "completed");
    assert.ok(appended.includes("pi-tasks:run-finished"), "run-finished persisted");
    assert.ok(appended.includes("pi-tasks:evidence-recorded"), "evidence persisted");
  });

  it("ignores tasks that are already terminal (idempotent)", () => {
    const id = seedAsyncTask(store, "s1", "async-3");
    applyAsyncCompletion(
      { id: "async-3", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
    );
    const firstEvidence = store.readTask("s1", id)!.evidence.length;
    // second completion for the same payload — must not double-close
    const handled = applyAsyncCompletion(
      { id: "async-3", status: "failed", summary: "again", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
    );
    assert.equal(handled.size, 0, "no scope should be re-handled on an already-terminal task");
    const task = store.readTask("s1", id)!;
    assert.equal(task.status, "completed", "status must not flip to failed");
    assert.equal(task.evidence.length, firstEvidence, "no extra evidence appended");
  });

  it("returns empty set and no-ops when payload has no ids", () => {
    const handled = applyAsyncCompletion(
      { status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
    );
    assert.equal(handled.size, 0);
  });

  it("only closes tasks in the given scopes, leaving other scopes untouched", () => {
    const inScope = seedAsyncTask(store, "s1", "async-4");
    const outScope = seedAsyncTask(store, "s2", "async-4");
    applyAsyncCompletion(
      { id: "async-4", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
    );
    assert.equal(store.readTask("s1", inScope)?.status, "completed");
    assert.equal(store.readTask("s2", outScope)?.status, "in_progress");
  });

  it("uses the event-name option as the evidence source metadata", () => {
    const id = seedAsyncTask(store, "s1", "async-5");
    applyAsyncCompletion(
      { id: "async-5", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
      { eventName: "custom:event" },
    );
    const ev = store.readTask("s1", id)!.evidence.at(-1)!;
    assert.equal(ev.metadata?.source, "custom:event");
    assert.equal(ev.metadata?.asyncId, "async-5");
  });

  it("defaults the evidence source to the async-complete event name", () => {
    const id = seedAsyncTask(store, "s1", "async-6");
    applyAsyncCompletion(
      { id: "async-6", status: "completed", summary: "ok", cwd: "/repo" },
      new Set(["s1"]),
      { store, shouldPersist: () => true, emitFinished: () => {} },
    );
    const ev = store.readTask("s1", id)!.evidence.at(-1)!;
    assert.equal(ev.metadata?.source, SUBAGENT_ASYNC_COMPLETE_EVENT);
  });
});
