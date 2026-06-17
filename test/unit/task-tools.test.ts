import test from "node:test";
import assert from "node:assert/strict";
import { registerTaskTools } from "../../src/extension/src/task-tools.ts";
import { taskStore, type TaskEvent, type TaskRunRecord } from "../../src/extension/src/task-store.ts";

type Handler = (data: unknown) => void;

function createEventBus(options: { parallelResultCount?: number; statusText?: string; emitUpdate?: boolean } = {}) {
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
        const children = Array.isArray(request.params?.tasks) ? request.params.tasks as Array<Record<string, unknown>> : [];
        for (const handler of handlers.get("subagent:slash:started") ?? []) handler({ requestId: request.requestId });
        // When emitUpdate is set, stream a per-child progress update before the
        // final response, simulating pi-subagents' parallel progress fanout.
        if (options.emitUpdate && children.length > 0) {
          const progress = children.map((child, index) => ({ index, agent: child.agent, currentTool: index === 0 ? "read" : "edit", toolCount: (index + 1) * 2 }));
          for (const handler of handlers.get("subagent:slash:update") ?? []) handler({ requestId: request.requestId, progress });
        } else if (options.emitUpdate) {
          for (const handler of handlers.get("subagent:slash:update") ?? []) handler({ requestId: request.requestId, progress: [{ index: 0, agent: "worker", currentTool: "read", toolCount: 1 }] });
        }
        const isInterrupt = request.params?.action === "interrupt";
        const isResume = request.params?.action === "resume";
        const isStatus = request.params?.action === "status";
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

function createHarness(options: { parallelResultCount?: number; statusText?: string; emitUpdate?: boolean } = {}) {
  const tools = new Map<string, any>();
  const events = createEventBus(options);
  const pi = {
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    events,
  };
  const activityCalls: Array<{ taskId: string; tool?: string; count: number }> = [];
  registerTaskTools(pi as any, () => {}, (_scope, taskId, activity) => {
    activityCalls.push({ taskId, tool: activity.tool, count: activity.count });
  });
  return { tools, events, activityCalls };
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

function seedCompletedAsyncTaskWithOutput(): string {
  const task = taskStore.createTask("session-1", { title: "Async done", prompt: "ran in background", cwd: "/repo" });
  taskStore.startRun("session-1", task.id, makeRun(task.id, "detached"));
  taskStore.finishRun("session-1", task.id, "completed", {
    summary: "background complete",
    output: "background complete",
    subagent: {
      asyncId: "async-1",
      savedOutputs: ["/tmp/async-out.md"],
      artifactOutputs: ["/tmp/artifact.md"],
      sessionFiles: ["/tmp/session.jsonl"],
    },
  });
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

test("TaskCreate appends an activeForm tip when activeForm is omitted", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const { tools } = createHarness();

  const result = await tools.get("TaskCreate").execute("call-1", {
    subject: "Build thing",
    description: "Implement the thing",
  }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Task #1 created: Build thing/);
  assert.match(result.content[0].text, /Tip: set activeForm/);
  assert.equal(taskStore.readTask("session-1", "1")?.activeForm, undefined);
  assert.equal(taskStore.readTask("session-1", "1")?.status, "pending");
});

test("TaskCreate omits the activeForm tip when activeForm is provided", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const { tools } = createHarness();

  const result = await tools.get("TaskCreate").execute("call-1", {
    subject: "Build thing",
    description: "Implement the thing",
    activeForm: "Building thing",
  }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Task #1 created: Build thing/);
  assert.doesNotMatch(result.content[0].text, /Tip: set activeForm/);
  assert.equal(taskStore.readTask("session-1", "1")?.activeForm, "Building thing");
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

test("TaskList hides completed blockers from blockedBy summaries", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const blocker = taskStore.createTask("session-1", { title: "Blocker", prompt: "First", cwd: "/repo" });
  const target = taskStore.createTask("session-1", { title: "Target", prompt: "Second", blockedBy: [blocker.id], cwd: "/repo" });
  taskStore.updateStatus("session-1", blocker.id, "completed", "done");
  const { tools } = createHarness();

  const result = await tools.get("TaskList").execute("call-1", {}, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#2 \[pending\] Target/);
  assert.doesNotMatch(result.content[0].text, /#2 \[pending\] Target .*\[blocked by #1\]/);
  assert.deepEqual(result.details.tasks.map((task: { id: string }) => task.id), [blocker.id, target.id]);
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

test("TaskUpdate completion result nudges the agent to list newly ready work", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const blocker = taskStore.createTask("session-1", { title: "Blocker", prompt: "First", cwd: "/repo" });
  const target = taskStore.createTask("session-1", { title: "Target", prompt: "Second", blockedBy: [blocker.id], cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskUpdate").execute("call-1", { taskId: blocker.id, status: "completed" }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Updated task #1: completed/);
  assert.match(result.content[0].text, /Task completed\. Call TaskList now to find newly unblocked work\. Ready: #2\./);
  assert.equal(taskStore.readTask("session-1", target.id)?.status, "pending");
});

test("TaskUpdate verification nudge fires when closing out 3+ tasks without a verify step", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const a = taskStore.createTask("session-1", { title: "A", prompt: "pa", cwd: "/repo" });
  const b = taskStore.createTask("session-1", { title: "B", prompt: "pb", cwd: "/repo" });
  const c = taskStore.createTask("session-1", { title: "C", prompt: "pc", cwd: "/repo" });
  const { tools } = createHarness();
  await tools.get("TaskUpdate").execute("c1", { taskId: a.id, status: "completed" }, undefined, undefined, createCtx());
  await tools.get("TaskUpdate").execute("c2", { taskId: b.id, status: "completed" }, undefined, undefined, createCtx());
  const last = await tools.get("TaskUpdate").execute("c3", { taskId: c.id, status: "completed" }, undefined, undefined, createCtx());
  assert.match(last.content[0].text, /verify the work/i);
  assert.match(last.content[0].text, /fresh-eyes/);
  assert.doesNotMatch(last.content[0].text, /confirm no ready follow-up work remains/);
});

test("TaskUpdate verification nudge is suppressed when a task carried a verify step", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const a = taskStore.createTask("session-1", { title: "A", prompt: "pa", cwd: "/repo" });
  const b = taskStore.createTask("session-1", { title: "B", prompt: "pb", cwd: "/repo" });
  taskStore.createTask("session-1", {
    title: "C",
    prompt: "pc",
    cwd: "/repo",
    acceptance: { verify: [{ id: "v1", command: "npm test" }] },
  });
  const { tools } = createHarness();
  await tools.get("TaskUpdate").execute("c1", { taskId: a.id, status: "completed" }, undefined, undefined, createCtx());
  await tools.get("TaskUpdate").execute("c2", { taskId: b.id, status: "completed" }, undefined, undefined, createCtx());
  const last = await tools.get("TaskUpdate").execute("c3", { taskId: "3", status: "completed" }, undefined, undefined, createCtx());
  assert.doesNotMatch(last.content[0].text, /verify the work/i);
  assert.match(last.content[0].text, /confirm no ready follow-up work remains/);
});

test("TaskUpdate verification nudge does not fire below the 3-task threshold", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const a = taskStore.createTask("session-1", { title: "A", prompt: "pa", cwd: "/repo" });
  const b = taskStore.createTask("session-1", { title: "B", prompt: "pb", cwd: "/repo" });
  const { tools } = createHarness();
  await tools.get("TaskUpdate").execute("c1", { taskId: a.id, status: "completed" }, undefined, undefined, createCtx());
  const last = await tools.get("TaskUpdate").execute("c2", { taskId: b.id, status: "completed" }, undefined, undefined, createCtx());
  assert.doesNotMatch(last.content[0].text, /verify the work/i);
  assert.match(last.content[0].text, /confirm no ready follow-up work remains/);
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

test("TaskOutput leads with output file paths when a run saved outputs", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedCompletedAsyncTaskWithOutput();
  const { tools } = createHarness();

  const result = await tools.get("TaskOutput").execute("call-1", { taskId: id, refresh: false }, undefined, undefined, createCtx());
  const text = result.content[0].text;

  // Header line stays first.
  assert.match(text, /^Task #1 \[completed\] Async done/);
  // Output files section leads, ahead of Run output and Evidence.
  const filesIdx = text.indexOf("## Output files");
  const runIdx = text.indexOf("## Run output");
  assert.ok(filesIdx > -1, "expected an Output files section");
  assert.ok(filesIdx < runIdx, "Output files must precede Run output");
  assert.match(text, /Saved output — read this file for the full result:\n  \/tmp\/async-out\.md/);
  assert.match(text, /Artifact output:\n  \/tmp\/artifact\.md/);
  assert.match(text, /Subagent session transcript \(reference only\):\n  \/tmp\/session\.jsonl/);
  // Structured run metadata is preserved in details.
  assert.equal(result.details.task.run.subagent.asyncId, "async-1");
  assert.deepEqual(result.details.task.run.subagent.savedOutputs, ["/tmp/async-out.md"]);
});

test("TaskOutput omits the Output files section when no paths are recorded", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedCompletedTask();
  const { tools } = createHarness();

  const result = await tools.get("TaskOutput").execute("call-1", { taskId: id, refresh: false }, undefined, undefined, createCtx());

  assert.doesNotMatch(result.content[0].text, /## Output files/);
  assert.match(result.content[0].text, /## Run output/);
});

test("TaskOutput does not refresh completed async runs just because an asyncId exists", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedCompletedAsyncTaskWithOutput();
  const { tools, events: bus } = createHarness();

  const result = await tools.get("TaskOutput").execute("call-1", { taskId: id }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /## Output files/);
  assert.equal(bus.requests.length, 0);
  assert.equal(taskStore.readTask("session-1", id)?.status, "completed");
});

test("TaskRun async launch summary includes read-output guidance when paths exist", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const task = taskStore.createTask("session-1", { title: "Background", prompt: "run async", cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskRun").execute("call-1", { taskId: task.id, async: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1: detached/);
  assert.match(result.content[0].text, /output saved to \/tmp\/out\.md; read it for the full result/);
  const stored = taskStore.readTask("session-1", task.id);
  assert.equal(stored?.run?.status, "detached");
  assert.deepEqual(stored?.run?.subagent.savedOutputs, ["/tmp/out.md"]);
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

test("TaskRun parallel fans out per-child activity so each task gets its own live line", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const a = taskStore.createTask("session-1", { title: "A", prompt: "pa", cwd: "/repo" });
  const b = taskStore.createTask("session-1", { title: "B", prompt: "pb", cwd: "/repo" });
  const { tools, activityCalls } = createHarness({ emitUpdate: true });

  await tools.get("TaskRun").execute("call-1", { task_ids: [a.id, b.id], parallel: true, concurrency: 2 }, undefined, undefined, createCtx());

  // The harness emits a slash:update with progress[{index:0, currentTool:"read", toolCount:2}, {index:1, currentTool:"edit", toolCount:4}].
  // Each child task should have received its own onActivity call with its tool/count.
  const byTask = new Map(activityCalls.map((entry) => [entry.taskId, entry]));
  assert.equal(byTask.get(a.id)?.tool, "read");
  assert.equal(byTask.get(a.id)?.count, 2);
  assert.equal(byTask.get(b.id)?.tool, "edit");
  assert.equal(byTask.get(b.id)?.count, 4);
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

test("TaskRun ready=true selects ready tasks and nudges toward newly ready work", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const first = taskStore.createTask("session-1", { title: "First", prompt: "Run first", cwd: "/repo" });
  const second = taskStore.createTask("session-1", { title: "Second", prompt: "Run second", blockedBy: [first.id], cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskRun").execute("call-1", { ready: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /#1: completed/);
  assert.match(result.content[0].text, /Task completed\. Call TaskList now to find newly unblocked work\. Ready: #2\./);
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

test("TaskClaim succeeds for an unowned pending task", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const task = taskStore.createTask("session-1", { title: "Claim me", prompt: "Work", cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: task.id, owner: "  alice  " }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claimed task #1 for alice/);
  assert.equal(result.details.claimed, true);
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, "alice");
  assert.equal(taskStore.readTask("session-1", task.id)?.status, "pending");
});

test("TaskClaim reports invalid_owner for blank owners without mutating", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const task = taskStore.createTask("session-1", { title: "Claim me", prompt: "Work", cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: task.id, owner: "   " }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claim failed for task #1: invalid_owner/);
  assert.equal(result.details.claimed, false);
  assert.equal(result.details.reason, "invalid_owner");
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, undefined);
});

test("TaskClaim with start sets status to in_progress", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const task = taskStore.createTask("session-1", { title: "Claim me", prompt: "Work", cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: task.id, owner: "alice", start: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claimed task #1 for alice \(in_progress\)/);
  assert.equal(taskStore.readTask("session-1", task.id)?.status, "in_progress");
});

test("TaskClaim reports structured failure for an already-owned task", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const task = taskStore.createTask("session-1", { title: "Owned", prompt: "Work", owner: "bob", cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: task.id, owner: "alice" }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claim failed for task #1: already_claimed/);
  assert.equal(result.details.claimed, false);
  assert.equal(result.details.reason, "already_claimed");
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, "bob");
});

test("TaskClaim force overrides already_claimed", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const task = taskStore.createTask("session-1", { title: "Owned", prompt: "Work", owner: "bob", cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: task.id, owner: "alice", force: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claimed task #1 for alice/);
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, "alice");
});

test("TaskClaim reports blocked with dependency ids", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const blocker = taskStore.createTask("session-1", { title: "Blocker", prompt: "First", cwd: "/repo" });
  const target = taskStore.createTask("session-1", { title: "Target", prompt: "Second", blockedBy: [blocker.id], cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: target.id, owner: "alice" }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claim failed for task #2: blocked/);
  assert.match(result.content[0].text, /blocked by #1/);
  assert.equal(result.details.reason, "blocked");
  assert.deepEqual(result.details.blockedByTasks, [blocker.id]);
});

test("TaskClaim reports owner_busy with open task ids", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const open = taskStore.createTask("session-1", { title: "Open", prompt: "In progress", cwd: "/repo" });
  taskStore.claimTask("session-1", open.id, { owner: "alice", start: true });
  const target = taskStore.createTask("session-1", { title: "Target", prompt: "Claim me", cwd: "/repo" });
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: target.id, owner: "alice", one_open_per_owner: true }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claim failed for task #2: owner_busy/);
  assert.match(result.content[0].text, /owner busy with #1/);
  assert.equal(result.details.reason, "owner_busy");
  assert.deepEqual(result.details.busyWithTasks, [open.id]);
});

test("TaskClaim reports already_terminal for a completed task", async () => {
  const events: TaskEvent[] = [];
  taskStore.reset();
  taskStore.setEventAppender((event) => events.push(event));
  const id = seedCompletedTask();
  const { tools } = createHarness();

  const result = await tools.get("TaskClaim").execute("call-1", { taskId: id, owner: "alice" }, undefined, undefined, createCtx());

  assert.match(result.content[0].text, /Claim failed for task #1: already_terminal/);
  assert.equal(result.details.reason, "already_terminal");
  assert.equal(taskStore.readTask("session-1", id)?.status, "completed");
});
