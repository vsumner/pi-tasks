import test from "node:test";
import assert from "node:assert/strict";
import piTasksExtension from "../../src/extension/index.ts";
import { taskStore, type TaskEvent, type TaskRunRecord } from "../../src/extension/src/task-store.ts";

type Handler = (data: unknown, ctx?: unknown) => void;

function createPi() {
  const eventHandlers = new Map<string, Set<Handler>>();
  const lifecycleHandlers = new Map<string, Handler>();
  const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
  const branchEntries: Array<{ type: "custom"; customType: string; data: Record<string, unknown>; timestamp: string }> = [];
  const labels: Array<{ id: string; label: string }> = [];
  const emitLifecycle = (event: string, ctx: unknown) => {
    lifecycleHandlers.get(event)?.({}, ctx);
  };
  return {
    appended,
    branchEntries,
    labels,
    emitLifecycle,
    pi: {
      registerTool() {},
      registerCommand() {},
      appendEntry(type: string, data: Record<string, unknown>) {
        appended.push({ type, data });
        branchEntries.push({ type: "custom", customType: type, data, timestamp: new Date().toISOString() });
      },
      setLabel(id: string, label: string) { labels.push({ id, label }); },
      on(event: string, handler: Handler) { lifecycleHandlers.set(event, handler); },
      events: {
        on(event: string, handler: Handler) {
          let set = eventHandlers.get(event);
          if (!set) {
            set = new Set();
            eventHandlers.set(event, set);
          }
          set.add(handler);
          return () => set?.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const handler of eventHandlers.get(event) ?? []) handler(data);
        },
      },
    },
  };
}

function asyncRun(taskId: string, asyncId = "async-1"): TaskRunRecord {
  return {
    id: `task-${taskId}-run`,
    taskId,
    status: "detached",
    agent: "worker",
    startedAt: "2026-01-01T00:00:00.000Z",
    subagent: {
      agent: "worker",
      asyncId,
      runId: asyncId,
      asyncDir: "/tmp/async-1",
      sessionFiles: [],
      savedOutputs: [],
      artifactOutputs: [],
    },
  };
}

test("session lifecycle reconstructs task projection from appended branch entries", () => {
  taskStore.reset();
  const { pi, branchEntries, emitLifecycle } = createPi();
  piTasksExtension(pi as any);
  const ctx = {
    cwd: "/repo",
    hasUI: false,
    sessionManager: { getSessionId: () => "session-1", getBranch: () => branchEntries },
    ui: {},
  };
  emitLifecycle("session_start", ctx);

  const task = taskStore.createTask("session-1", { title: "Persist", prompt: "Survive reconstruct", cwd: "/repo", metadata: { live: true } });
  taskStore.updateTask("session-1", task.id, { status: "blocked", owner: "integration" });
  assert.equal(taskStore.readTask("session-1", task.id)?.status, "blocked");

  taskStore.applyEvents("session-1", []);
  assert.equal(taskStore.readTask("session-1", task.id), null);

  emitLifecycle("before_agent_start", ctx);
  const restored = taskStore.readTask("session-1", task.id);
  assert.equal(restored?.status, "blocked");
  assert.equal(restored?.owner, "integration");
  assert.deepEqual(restored?.metadata, { live: true });
  assert.ok(branchEntries.every((entry) => entry.type === "custom" && entry.customType.startsWith("pi-tasks:")));
});

test("async-complete updates matching task and preserves output artifact refs", () => {
  taskStore.reset();
  const { pi, appended } = createPi();
  piTasksExtension(pi as any);

  const task = taskStore.createTask("session-1", { title: "Async", prompt: "Run async", cwd: "/repo" });
  taskStore.startRun("session-1", task.id, asyncRun(task.id));

  pi.events.emit("subagent:async-complete", {
    cwd: "/repo",
    sessionId: "session-1",
    id: "async-1",
    status: "completed",
    results: [{ finalOutput: "async done", savedOutputPath: "/tmp/out.md", artifactPath: "/tmp/artifact.md", sessionFile: "/tmp/session.jsonl" }],
  });

  const latest = taskStore.readTask("session-1", task.id);
  assert.equal(latest?.status, "completed");
  assert.equal(latest?.run?.output, "async done");
  assert.deepEqual(latest?.run?.subagent.savedOutputs, ["/tmp/out.md"]);
  assert.deepEqual(latest?.run?.subagent.artifactOutputs, ["/tmp/artifact.md"]);
  assert.deepEqual(latest?.run?.subagent.sessionFiles, ["/tmp/session.jsonl"]);
  assert.ok(appended.some((event) => event.type === "pi-tasks:run-finished"));
  assert.ok(appended.every((event) => event.data.version === 1));
});

test("async-complete updates memory but does not append task events into another active session", () => {
  taskStore.reset();
  const { pi, appended, emitLifecycle } = createPi();
  piTasksExtension(pi as any);

  const ctxA = { cwd: "/repo", hasUI: false, sessionManager: { getSessionId: () => "session-A", getBranch: () => [] }, ui: {} };
  const ctxB = { cwd: "/repo", hasUI: false, sessionManager: { getSessionId: () => "session-B", getBranch: () => [] }, ui: {} };
  emitLifecycle("session_start", ctxA);
  const task = taskStore.createTask("session-A", { title: "Async A", prompt: "Run async", cwd: "/repo" });
  taskStore.startRun("session-A", task.id, asyncRun(task.id, "async-A"));
  appended.length = 0;

  emitLifecycle("session_start", ctxB);
  pi.events.emit("subagent:async-complete", { cwd: "/repo", sessionId: "session-A", id: "async-A", status: "completed", summary: "done in A" });

  assert.equal(taskStore.readTask("session-A", task.id)?.status, "completed");
  assert.deepEqual(appended.map((event) => event.type), []);
});

test("async-complete ignores unrelated async ids", () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const { pi } = createPi();
  piTasksExtension(pi as any);

  const task = taskStore.createTask("session-1", { title: "Async", prompt: "Run async", cwd: "/repo" });
  taskStore.startRun("session-1", task.id, asyncRun(task.id, "async-expected"));

  pi.events.emit("subagent:async-complete", { cwd: "/repo", sessionId: "session-1", id: "async-other", status: "completed", summary: "wrong" });

  assert.equal(taskStore.readTask("session-1", task.id)?.status, "in_progress");
});
