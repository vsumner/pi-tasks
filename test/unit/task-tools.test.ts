import test from "node:test";
import assert from "node:assert/strict";
import { registerTaskTools } from "../../src/extension/src/task-tools.ts";
import { taskStore, type TaskEvent, type TaskRunRecord } from "../../src/extension/src/task-store.ts";

type Handler = (data: unknown) => void;

function createEventBus(options: { parallelResultCount?: number; statusText?: string } = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const requests: unknown[] = [];
  return {
    requests,
    on(event: string, handler: Handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    emit(event: string, data: unknown) {
      if (event === "subagent:slash:request") {
        requests.push(data);
        const request = data as { requestId: string; params?: Record<string, unknown> };
        for (const handler of handlers.get("subagent:slash:started") ?? []) handler({ requestId: request.requestId });
        const isInterrupt = request.params?.action === "interrupt";
        const isResume = request.params?.action === "resume";
        const isStatus = request.params?.action === "status";
        const children = Array.isArray(request.params?.tasks) ? request.params.tasks as Array<Record<string, unknown>> : [];
        const text = isInterrupt ? "Async run not found" : isResume ? "Resume complete" : isStatus ? options.statusText ?? "State: complete" : children.length ? "Parallel complete" : "State: complete";
        const parallelResults = children.map((child, index) => ({ agent: child.agent as string, exitCode: 0, finalOutput: `parallel output ${index + 1}`, savedOutputPath: `/tmp/out-${index + 1}.md` }));
        const limitedParallelResults = typeof options.parallelResultCount === "number" ? parallelResults.slice(0, options.parallelResultCount) : parallelResults;
        const results = children.length
          ? limitedParallelResults
          : [{ agent: "worker", exitCode: 0, finalOutput: text, savedOutputPath: "/tmp/out.md" }];
        for (const handler of handlers.get("subagent:slash:response") ?? []) {
          handler({
            requestId: request.requestId,
            isError: isInterrupt,
            errorText: isInterrupt ? "Async run not found" : undefined,
            result: {
              isError: isInterrupt,
              content: [{ type: "text", text }],
              details: { mode: children.length ? "parallel" : "single", runId: isResume ? "resumed-run" : "run-1", results },
            },
          });
        }
        return;
      }
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
  };
}

function createHarness(options: { parallelResultCount?: number; statusText?: string } = {}) {
  const tools = new Map<string, any>();
  const events = createEventBus(options);
  const pi = {
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    events,
  };
  registerTaskTools(pi as any, () => {});
  return { tools, events };
}

function createCtx() {
  return {
    cwd: "/repo",
    mode: "json",
    hasUI: false,
    sessionManager: { getSessionId: () => "session-1" },
    ui: { setStatus() {} },
  };
}

function makeRun(taskId: string, status: TaskRunRecord["status"] = "running"): TaskRunRecord {
  return {
    id: `task-${taskId}-run`,
    taskId,
    status,
    agent: "worker",
    startedAt: "2026-01-01T00:00:00.000Z",
    subagent: {
      agent: "worker",
      runId: "foreground-run-1",
      sessionFiles: [],
      savedOutputs: [],
      artifactOutputs: [],
    },
  };
}

function seedCompletedTask(): string {
  const task = taskStore.createTask("session-1", { title: "Done", prompt: "Already done", cwd: "/repo" });
  taskStore.startRun("session-1", task.id, makeRun(task.id));
  taskStore.finishRun("session-1", task.id, "completed", { summary: "done", output: "done" });
  return task.id;
}

function seedInFlightTask(): string {
  const task = taskStore.createTask("session-1", { title: "Running", prompt: "Still running", cwd: "/repo" });
  taskStore.startRun("session-1", task.id, makeRun(task.id, "detached"));
  return task.id;
}

test("TaskCreate validates required fields and stores normalized task data", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const { tools } = createHarness();

  await assert.rejects(
    tools.get("TaskCreate").execute("call-1", { subject: "   ", description: "Do work" }, undefined, undefined, createCtx()),
    /Task title is required/,
  );
  await assert.rejects(
    tools.get("TaskCreate").execute("call-2", { subject: "Build", description: "   " }, undefined, undefined, createCtx()),
    /Task prompt is required/,
  );

  const result = await tools.get("TaskCreate").execute("call-3", {
    subject: "  Build thing  ",
    description: "  Implement the thing  ",
    activeForm: "  Building thing  ",
    agent: "  worker  ",
    kind: "packet",
    source: "pi-goals",
    metadata: { goalId: "goal-1" },
  }, undefined, undefined, createCtx());

  const task = result.details.task;
  assert.match(result.content[0].text, /Task #1 created: Build thing/);
  assert.equal(task.title, "Build thing");
  assert.equal(task.prompt, "Implement the thing");
  assert.equal(task.activeForm, "Building thing");
  assert.equal(task.agent, "worker");
  assert.equal(task.kind, "packet");
  assert.equal(task.source, "pi-goals");
  assert.deepEqual(task.metadata, { goalId: "goal-1" });
  assert.equal(taskStore.readTask("session-1", "1")?.status, "pending");
});

test("TaskList filters ready tasks and stored statuses", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const ready = taskStore.createTask("session-1", { title: "Ready", prompt: "Can run", cwd: "/repo" });
  const blocked = taskStore.createTask("session-1", { title: "Blocked", prompt: "Wait", blockedBy: [ready.id], cwd: "/repo" });
  const done = taskStore.createTask("session-1", { title: "Done", prompt: "Finished", cwd: "/repo" });
  taskStore.startRun("session-1", done.id, makeRun(done.id));
  taskStore.finishRun("session-1", done.id, "completed", { summary: "done" });
  const { tools } = createHarness();

  const readyResult = await tools.get("TaskList").execute("call-1", { ready_only: true }, undefined, undefined, createCtx());
  assert.match(readyResult.content[0].text, /#1 \[pending\] Ready/);
  assert.doesNotMatch(readyResult.content[0].text, /Blocked/);
  assert.doesNotMatch(readyResult.content[0].text, /Done/);
  assert.deepEqual(readyResult.details.tasks.map((task: { id: string }) => task.id), [ready.id]);

  const completedResult = await tools.get("TaskList").execute("call-2", { status: "completed" }, undefined, undefined, createCtx());
  assert.match(completedResult.content[0].text, /#3 \[completed\] Done/);
  assert.doesNotMatch(completedResult.content[0].text, /Ready/);
  assert.deepEqual(completedResult.details.tasks.map((task: { id: string }) => task.id), [done.id]);

  assert.equal(blocked.blockedBy[0], ready.id);
});

test("TaskGet returns details including dependency, evidence, and metadata", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const parent = taskStore.createTask("session-1", { title: "Parent", prompt: "First", cwd: "/repo" });
  const child = taskStore.createTask("session-1", { title: "Child", prompt: "Second", blockedBy: [parent.id], metadata: { packetId: "packet-1" }, cwd: "/repo" });
  taskStore.recordEvidence("session-1", child.id, { id: "ev-1", kind: "note", text: "checked", ts: "2026-01-01T00:00:00.000Z" });
  const { tools } = createHarness();

  const result = await tools.get("TaskGet").execute("call-1", { taskId: child.id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Task #2: Child/);
  assert.match(result.content[0].text, /Blocked by: #1/);
  assert.match(result.content[0].text, /Evidence:\n- \[note\] checked/);
  assert.match(result.content[0].text, /Metadata: \{"packetId":"packet-1"\}/);
  assert.equal(result.details.task.id, child.id);
});

test("TaskUpdate merges metadata, edits dependency edges, records notes, and deletes", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const blocker = taskStore.createTask("session-1", { title: "Blocker", prompt: "First", cwd: "/repo" });
  const target = taskStore.createTask("session-1", { title: "Target", prompt: "Second", metadata: { keep: "yes", remove: "old" }, cwd: "/repo" });
  const { tools } = createHarness();

  const updated = await tools.get("TaskUpdate").execute("call-1", {
    taskId: target.id,
    subject: "Updated target",
    metadata: { remove: null, added: "new" },
    addBlockedBy: [blocker.id],
    note: "linked dependency",
  }, undefined, undefined, createCtx());

  assert.match(updated.content[0].text, /Updated task #2: pending — Updated target/);
  assert.deepEqual(taskStore.readTask("session-1", target.id)?.metadata, { keep: "yes", added: "new" });
  assert.deepEqual(taskStore.readTask("session-1", target.id)?.blockedBy, [blocker.id]);
  assert.deepEqual(taskStore.readTask("session-1", blocker.id)?.blocks, [target.id]);
  assert.ok(taskStore.readTask("session-1", target.id)?.evidence.some((e) => e.text === "linked dependency"));

  await tools.get("TaskUpdate").execute("call-2", { taskId: target.id, removeBlockedBy: [blocker.id] }, undefined, undefined, createCtx());
  assert.deepEqual(taskStore.readTask("session-1", target.id)?.blockedBy, []);
  assert.deepEqual(taskStore.readTask("session-1", blocker.id)?.blocks, []);

  const deleted = await tools.get("TaskUpdate").execute("call-3", { taskId: target.id, status: "deleted" }, undefined, undefined, createCtx());
  assert.match(deleted.content[0].text, /Task #2 deleted/);
  assert.equal(taskStore.readTask("session-1", target.id), null);
});

test("TaskStop does not cancel a completed task when interrupt fails", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedCompletedTask();
  const { tools } = createHarness();

  const result = await tools.get("TaskStop").execute("call-1", { taskId: id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /not in-flight/);
  assert.equal(taskStore.readTask("session-1", id)?.status, "completed");
  assert.equal(taskStore.readTask("session-1", id)?.run?.status, "completed");
});

test("TaskStop does not change an in-flight task when pi-subagents interrupt returns an error", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedInFlightTask();
  const { tools } = createHarness();

  const result = await tools.get("TaskStop").execute("call-1", { taskId: id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /stop failed/);
  assert.equal(taskStore.readTask("session-1", id)?.status, "in_progress");
  assert.equal(taskStore.readTask("session-1", id)?.run?.status, "detached");
});

test("TaskRun keeps not-yet-started tasks pending when signal is already aborted", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const first = taskStore.createTask("session-1", { title: "First", prompt: "Run first", cwd: "/repo" });
  const second = taskStore.createTask("session-1", { title: "Second", prompt: "Run second", cwd: "/repo" });
  const { tools } = createHarness();
  const controller = new AbortController();
  controller.abort();

  const result = await tools.get("TaskRun").execute("call-1", { task_ids: [first.id, second.id] }, controller.signal, undefined, createCtx());

  assert.match(result.content[0].text, /aborted before remaining tasks started/);
  assert.equal(taskStore.readTask("session-1", first.id)?.status, "pending");
  assert.equal(taskStore.readTask("session-1", second.id)?.status, "pending");
});

test("TaskOutput does not refresh completed foreground runIds as async ids", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedCompletedTask();
  const { tools, events: bus } = createHarness();

  const result = await tools.get("TaskOutput").execute("call-1", { taskId: id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Run output\n done|Run output\ndone/);
  assert.equal(bus.requests.length, 0);
  assert.equal(taskStore.readTask("session-1", id)?.run?.subagent.runId, "foreground-run-1");
});

test("TaskRun foreground parallel maps ordered child results to tasks", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const first = taskStore.createTask("session-1", { title: "First", prompt: "Run first", cwd: "/repo" });
  const second = taskStore.createTask("session-1", { title: "Second", prompt: "Run second", cwd: "/repo" });
  const { tools, events: bus } = createHarness();

  const result = await tools.get("TaskRun").execute("call-1", { task_ids: [first.id, second.id], parallel: true, concurrency: 2 }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1: completed/);
  assert.match(result.content[0].text, /#2: completed/);
  assert.equal((bus.requests[0] as { params?: { tasks?: unknown[] } }).params?.tasks?.length, 2);
  assert.equal(taskStore.readTask("session-1", first.id)?.run?.output, "parallel output 1");
  assert.equal(taskStore.readTask("session-1", second.id)?.run?.output, "parallel output 2");
  assert.deepEqual(taskStore.readTask("session-1", first.id)?.run?.subagent.savedOutputs, ["/tmp/out-1.md"]);
});

test("TaskRun foreground parallel marks missing child results as failed", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const first = taskStore.createTask("session-1", { title: "First", prompt: "Run first", cwd: "/repo" });
  const second = taskStore.createTask("session-1", { title: "Second", prompt: "Run second", cwd: "/repo" });
  const { tools } = createHarness({ parallelResultCount: 1 });

  const result = await tools.get("TaskRun").execute("call-1", { task_ids: [first.id, second.id], parallel: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1: completed/);
  assert.match(result.content[0].text, /#2: failed/);
  assert.equal(taskStore.readTask("session-1", first.id)?.status, "completed");
  assert.equal(taskStore.readTask("session-1", second.id)?.status, "failed");
  assert.equal(taskStore.readTask("session-1", second.id)?.run?.error, "Missing pi-subagents result for this task.");
});

test("TaskRun rejects async parallel instead of starting tasks", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const first = taskStore.createTask("session-1", { title: "First", prompt: "Run first", cwd: "/repo" });
  const second = taskStore.createTask("session-1", { title: "Second", prompt: "Run second", cwd: "/repo" });
  const { tools, events: bus } = createHarness();

  const result = await tools.get("TaskRun").execute("call-1", { task_ids: [first.id, second.id], parallel: true, async: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Parallel async TaskRun is not supported/);
  assert.equal(bus.requests.length, 0);
  assert.equal(taskStore.readTask("session-1", first.id)?.status, "pending");
  assert.equal(taskStore.readTask("session-1", second.id)?.status, "pending");
});

test("TaskRun ready=true selects ready tasks", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const first = taskStore.createTask("session-1", { title: "First", prompt: "Run first", cwd: "/repo" });
  const second = taskStore.createTask("session-1", { title: "Second", prompt: "Run second", blockedBy: [first.id], cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskRun").execute("call-1", { ready: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1: completed/);
  assert.equal(taskStore.readTask("session-1", first.id)?.status, "completed");
  assert.equal(taskStore.readTask("session-1", second.id)?.status, "pending");
});

test("TaskRetry reruns failed tasks while preserving retry evidence", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const task = taskStore.createTask("session-1", { title: "Retry me", prompt: "Try again", cwd: "/repo" });
  taskStore.startRun("session-1", task.id, makeRun(task.id));
  taskStore.finishRun("session-1", task.id, "failed", { summary: "old failure", error: "old failure" });
  const { tools } = createHarness();

  const result = await tools.get("TaskRetry").execute("call-1", { taskId: task.id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1: completed/);
  const latest = taskStore.readTask("session-1", task.id);
  assert.equal(latest?.status, "completed");
  assert.ok(latest?.evidence.some((e) => e.text === "Retry requested."));
});

test("TaskResume refuses to clobber in-progress tasks", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedInFlightTask();
  const { tools, events: bus } = createHarness();

  const result = await tools.get("TaskResume").execute("call-1", { taskId: id, message: "keep going" }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /already in_progress/);
  assert.equal(bus.requests.length, 0);
  assert.equal(taskStore.readTask("session-1", id)?.status, "in_progress");
});

test("TaskResume sends a pi-subagents resume request and records output", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedInFlightTask();
  taskStore.finishRun("session-1", id, "cancelled", { summary: "cancelled", error: "cancelled" });
  const { tools, events: bus } = createHarness();

  const result = await tools.get("TaskResume").execute("call-1", { taskId: id, message: "keep going" }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /resumed: completed/);
  assert.equal(((bus.requests[0] as { params?: Record<string, unknown> }).params?.action), "resume");
  assert.equal(taskStore.readTask("session-1", id)?.status, "completed");
});

test("TaskWait refreshes detached async tasks to terminal state", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedInFlightTask();
  const { tools, events: bus } = createHarness();

  const result = await tools.get("TaskWait").execute("call-1", { taskId: id, timeout_ms: 1000, poll_ms: 10 }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /finished: completed/);
  assert.equal(((bus.requests[0] as { params?: Record<string, unknown> }).params?.action), "status");
  assert.equal(taskStore.readTask("session-1", id)?.status, "completed");
});

test("TaskStatus branch summary counts ready tasks from the whole branch when filtered", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const ready = taskStore.createTask("session-1", { title: "Ready", prompt: "Run me", cwd: "/repo" });
  const done = taskStore.createTask("session-1", { title: "Done", prompt: "Already done", cwd: "/repo" });
  taskStore.startRun("session-1", done.id, makeRun(done.id));
  taskStore.finishRun("session-1", done.id, "completed", { summary: "done" });
  const { tools } = createHarness();

  const result = await tools.get("TaskStatus").execute("call-1", { status: "completed" }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /1 ready/);
  assert.match(result.content[0].text, /#2 \[completed\]/);
  assert.doesNotMatch(result.content[0].text, /#1 \[pending\]/);
  assert.equal(taskStore.readTask("session-1", ready.id)?.status, "pending");
});

test("TaskStatus pins the current pi-subagents State: complete async status format", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedInFlightTask();
  const { tools } = createHarness({ statusText: "State: complete" });

  const result = await tools.get("TaskStatus").execute("call-1", { taskId: id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1 \[completed\]/);
  assert.match(result.content[0].text, /refresh: State: complete/);
  assert.equal(taskStore.readTask("session-1", id)?.status, "completed");
});

test("TaskStatus warns when async status output lacks a recognizable State line", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedInFlightTask();
  const { tools } = createHarness({ statusText: "No structured state here" });

  const result = await tools.get("TaskStatus").execute("call-1", { taskId: id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1 \[in_progress\]/);
  assert.match(result.content[0].text, /refresh: Unrecognized pi-subagents status format; task remains in_progress/);
  assert.equal(taskStore.readTask("session-1", id)?.status, "in_progress");
});

test("TaskWait timeout reports unrecognized async status state", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedInFlightTask();
  const { tools } = createHarness({ statusText: "State: done" });

  const result = await tools.get("TaskWait").execute("call-1", { taskId: id, timeout_ms: 1000, poll_ms: 1000 }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Timed out waiting for task #1/);
  assert.match(result.content[0].text, /Unrecognized pi-subagents status state "done"; task remains in_progress/);
  assert.equal(result.details.timedOut, true);
  assert.equal(taskStore.readTask("session-1", id)?.status, "in_progress");
});
