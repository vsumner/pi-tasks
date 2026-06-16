import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_CREATED_EVENT,
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_RUN_FINISHED_EVENT,
  TASK_RUN_STARTED_EVENT,
  TASK_UPDATED_EVENT,
} from "../../src/extension/src/events.ts";
import { getBranchTaskEvents, projectTasks } from "../../src/extension/src/task-projection.ts";
import { createTask, makeEvidence, type TaskRunRecord } from "../../src/extension/src/task-state.ts";

function ctxWithBranch(branch: unknown[]) {
  return { sessionManager: { getBranch: () => branch } };
}

test("getBranchTaskEvents extracts only pi-tasks custom entries in branch order", () => {
  const task = createTask({ title: "Setup", prompt: "Do setup" }, "1");
  const run: TaskRunRecord = {
    id: "run-1",
    taskId: "1",
    status: "running",
    agent: "worker",
    startedAt: "2026-01-01T00:00:01.000Z",
    subagent: { agent: "worker", sessionFiles: [], savedOutputs: [], artifactOutputs: [] },
  };
  const evidence = makeEvidence("proof", "tests passed");

  const branch = [
    { type: "message", message: { role: "user", content: [] }, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "custom", customType: "not-pi-tasks", data: { ignored: true }, timestamp: "2026-01-01T00:00:00.100Z" },
    { type: "custom", customType: TASK_CREATED_EVENT, data: { taskId: "1", task }, timestamp: "2026-01-01T00:00:00.200Z" },
    { type: "custom", customType: TASK_RUN_STARTED_EVENT, data: { taskId: "1", run }, timestamp: "2026-01-01T00:00:01.000Z" },
    { type: "custom", customType: TASK_RUN_FINISHED_EVENT, data: { taskId: "1", status: "completed", summary: "done" }, timestamp: "2026-01-01T00:00:02.000Z" },
    { type: "custom", customType: TASK_EVIDENCE_RECORDED_EVENT, data: { taskId: "1", evidence }, timestamp: "2026-01-01T00:00:03.000Z" },
  ];

  const events = getBranchTaskEvents(ctxWithBranch(branch));
  assert.deepEqual(events.map((event) => event.customType), [
    TASK_CREATED_EVENT,
    TASK_RUN_STARTED_EVENT,
    TASK_RUN_FINISHED_EVENT,
    TASK_EVIDENCE_RECORDED_EVENT,
  ]);

  const tasks = projectTasks(ctxWithBranch(branch));
  assert.equal(tasks[0]?.status, "completed");
  assert.equal(tasks[0]?.run?.summary, "done");
  assert.equal(tasks[0]?.evidence[0]?.text, "tests passed");
});

test("legacy tool-result taskEvent fallback is projected when present", () => {
  const task = createTask({ title: "Legacy", prompt: "Old details fallback" }, "1");
  const branch = [{
    type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName: "TaskCreate",
      details: {
        taskEvent: {
          type: "custom",
          customType: TASK_CREATED_EVENT,
          data: { taskId: "1", task },
        },
      },
    },
  }];

  assert.deepEqual(projectTasks(ctxWithBranch(branch)).map((item) => item.title), ["Legacy"]);
});

test("full task update events do not resurrect missing tasks", () => {
  const task = createTask({ title: "Missing", prompt: "Should not resurrect" }, "1");
  const tasks = projectTasks(ctxWithBranch([
    { type: "custom", customType: TASK_UPDATED_EVENT, data: { taskId: "1", task }, timestamp: "2026-01-01T00:00:00.000Z" },
  ]));

  assert.deepEqual(tasks, []);
});
