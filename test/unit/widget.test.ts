import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_COMPLETED_TTL_MS,
  hiddenSummary,
  isRecentlyCompleted,
  planWidget,
  renderLines,
  type Theme,
} from "../../src/extension/src/widget.ts";
import { createTask, type TaskActivity, type TaskItem, type TaskStatus } from "../../src/extension/src/task-state.ts";

const passthroughTheme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

function task(id: string, status: TaskStatus, extra: Partial<TaskItem> = {}): TaskItem {
  return { ...createTask({ title: `Task ${id}`, prompt: `Prompt ${id}` }, id), status, ...extra };
}

const NOW = Date.parse("2026-06-16T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
// Unambiguously stale relative to the real wall clock used by renderLines.
const EPOCH = new Date(0).toISOString();

test("planWidget keeps normal-sized lists in stable ID order", () => {
  const tasks = [
    task("6", "failed"),
    task("1", "completed", { updatedAt: iso(NOW - 120_000) }),
    task("4", "blocked"),
    task("3", "pending"),
    task("2", "in_progress"),
    task("5", "completed", { updatedAt: iso(NOW - 5_000) }),
  ];
  const plan = planWidget(tasks, NOW);
  assert.ok(plan);
  assert.deepEqual(
    plan!.visible.map((t) => t.id),
    ["1", "2", "3", "4", "5", "6"],
  );
});

test("planWidget uses priority buckets only when truncating", () => {
  const tasks = [
    task("1", "completed", { updatedAt: iso(NOW - 120_000) }), // old completed
    task("6", "failed"),
    task("4", "blocked"),
    task("3", "pending"), // ready pending
    task("2", "in_progress"),
    task("5", "completed", { updatedAt: iso(NOW - 5_000) }), // recent completed
  ];
  const plan = planWidget(tasks, NOW, 3);
  assert.ok(plan);
  // recent completed → in_progress → ready pending, with the rest hidden.
  assert.deepEqual(
    plan!.visible.map((t) => t.id),
    ["5", "2", "3"],
  );
  assert.deepEqual(plan!.hidden.map((t) => t.id), ["4", "6", "1"]);
});

test("ready pending sorts before blocked pending only when truncating", () => {
  const blocked = task("1", "pending", { blockedBy: ["9"] }); // #9 unresolved → blocked
  const ready = task("2", "pending");
  assert.deepEqual(planWidget([blocked, ready], NOW)!.visible.map((t) => t.id), ["1", "2"]);
  assert.deepEqual(planWidget([blocked, ready], NOW, 1)!.visible.map((t) => t.id), ["2"]);
});

test("failed and cancelled share a truncation bucket that precedes old completed", () => {
  const tasks = [
    task("1", "completed", { updatedAt: iso(NOW - 120_000) }), // old completed
    task("3", "cancelled"),
    task("2", "failed"),
  ];
  const plan = planWidget(tasks, NOW, 2);
  assert.deepEqual(plan!.visible.map((t) => t.id), ["2", "3"]);
  assert.deepEqual(plan!.hidden.map((t) => t.id), ["1"]);
});

test("planWidget hides when there are no tasks", () => {
  assert.equal(planWidget([], NOW), null);
});

test("planWidget hides when only stale completed tasks remain", () => {
  const stale = [
    task("1", "completed", { updatedAt: iso(NOW - 6_000) }),
    task("2", "completed", { updatedAt: iso(NOW - 120_000) }),
  ];
  assert.equal(planWidget(stale, NOW), null);
});

test("completed-only tasks stay visible briefly then hide", () => {
  const recent = task("1", "completed", { updatedAt: iso(NOW - 5_000) });
  assert.deepEqual(planWidget([recent], NOW)!.visible.map((t) => t.id), ["1"]);
  // Inclusive 5s completed-only boundary still renders.
  assert.ok(planWidget([recent], NOW));
  // Past the completed-only hide delay the widget hides.
  assert.equal(planWidget([recent], NOW + 1), null);
});

test("stale completed alongside active work keeps the widget visible in ID order", () => {
  const tasks = [
    task("1", "completed", { updatedAt: iso(NOW - 120_000) }), // stale, but…
    task("2", "in_progress"), // …active work keeps the widget up
  ];
  const plan = planWidget(tasks, NOW);
  assert.ok(plan);
  assert.deepEqual(plan!.visible.map((t) => t.id), ["1", "2"]);
});

test("isRecentlyCompleted is bounded for completed tasks and true otherwise", () => {
  assert.equal(isRecentlyCompleted(task("1", "in_progress"), NOW), true);
  assert.equal(isRecentlyCompleted(task("1", "completed", { updatedAt: iso(NOW - 5_000) }), NOW), true);
  assert.equal(isRecentlyCompleted(task("1", "completed", { updatedAt: iso(NOW - RECENT_COMPLETED_TTL_MS) }), NOW), true);
  assert.equal(isRecentlyCompleted(task("1", "completed", { updatedAt: iso(NOW - RECENT_COMPLETED_TTL_MS - 1) }), NOW), false);
  assert.equal(isRecentlyCompleted(task("1", "completed", { updatedAt: "not-a-date" }), NOW), false);
});

test("planWidget truncates visible rows and reports the hidden remainder", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task(String(i + 1), "pending"));
  const plan = planWidget(tasks, NOW, 5);
  assert.ok(plan);
  assert.equal(plan!.visible.length, 5);
  assert.equal(plan!.hidden.length, 7);
});

test("hiddenSummary is source-backed by status counts in priority order", () => {
  const tasks: TaskItem[] = [];
  for (let i = 1; i <= 6; i++) tasks.push(task(String(i), "in_progress"));
  for (let i = 7; i <= 12; i++) tasks.push(task(String(i), "pending"));
  const plan = planWidget(tasks, NOW, 5)!;
  // 5 in_progress become visible; remainder = 1 active + 6 open.
  assert.equal(plan.hidden.length, 7);
  assert.equal(hiddenSummary(plan.hidden), "1 active, 6 open");
});

test("hiddenSummary covers every status label", () => {
  assert.equal(
    hiddenSummary([
      task("1", "in_progress"),
      task("2", "pending"),
      task("3", "blocked"),
      task("4", "failed"),
      task("5", "cancelled"),
      task("6", "completed"),
    ]),
    "1 active, 1 open, 1 blocked, 1 failed, 1 cancelled, 1 done",
  );
});

test("renderLines keeps Pi-specific ready and failed counts in the header", () => {
  const tasks = [
    task("2", "in_progress"),
    task("3", "pending"),
    task("6", "failed"),
    task("1", "completed", { updatedAt: EPOCH }),
  ];
  const lines = renderLines(tasks, passthroughTheme, 0, 200);
  assert.ok(lines.length > 0);
  assert.match(lines[0]!, /1 ready/);
  assert.match(lines[0]!, /1 failed/);
});

test("renderLines renders nothing when only stale completed tasks remain", () => {
  const stale = [task("1", "completed", { updatedAt: EPOCH })];
  assert.deepEqual(renderLines(stale, passthroughTheme, 0, 200), []);
});

test("renderLines surfaces a Next: hint for the lowest-ID ready task when idle", () => {
  const tasks = [
    task("3", "pending"),
    task("1", "pending", { activeForm: "Doing task one" }),
  ];
  const lines = renderLines(tasks, passthroughTheme, 0, 200);
  const nextLine = lines.at(-1);
  assert.ok(nextLine, "expected a rendered line");
  assert.match(nextLine!, /Next: Doing task one/);
});

test("renderLines suppresses the Next: hint while a task is in_progress", () => {
  const tasks = [
    task("1", "in_progress"),
    task("2", "pending", { activeForm: "Doing task two" }),
  ];
  const lines = renderLines(tasks, passthroughTheme, 0, 200);
  assert.ok(!lines.some((line) => /Next:/.test(line)));
});

test("renderLines shows a live activity line for an in_progress task with fresh activity", () => {
  const tasks = [task("1", "in_progress", { activeForm: "Building feature" })];
  const activity = new Map<string, TaskActivity>([["1", { tool: "read", count: 3, ts: Date.now() }]]);
  const lines = renderLines(tasks, passthroughTheme, 0, 200, activity);
  assert.ok(lines.some((line) => /read · 3 tools…/.test(line)));
});

test("renderLines suppresses the activity line when activity is stale", () => {
  const tasks = [task("1", "in_progress", { activeForm: "Building feature" })];
  const stale: TaskActivity = { tool: "read", count: 3, ts: Date.now() - 120_000 };
  const activity = new Map<string, TaskActivity>([["1", stale]]);
  const lines = renderLines(tasks, passthroughTheme, 0, 200, activity);
  assert.ok(!lines.some((line) => /read · 3 tools…/.test(line)));
});

test("renderLines never shows an activity line for non-in_progress tasks", () => {
  const tasks = [task("1", "pending"), task("2", "completed", { updatedAt: new Date().toISOString() })];
  const activity = new Map<string, TaskActivity>([
    ["1", { tool: "read", count: 1, ts: Date.now() }],
    ["2", { tool: "read", count: 1, ts: Date.now() }],
  ]);
  const lines = renderLines(tasks, passthroughTheme, 0, 200, activity);
  assert.ok(!lines.some((line) => /read · 1 tool…/.test(line)));
});

test("renderLines shows a compact output-saved hint for completed async runs", () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const completed = task("1", "completed", {
    updatedAt: recent,
    run: {
      id: "task-1-run",
      taskId: "1",
      status: "completed",
      agent: "worker",
      startedAt: recent,
      finishedAt: recent,
      subagent: {
        agent: "worker",
        asyncId: "async-1",
        sessionFiles: [],
        savedOutputs: ["/tmp/async-out.md"],
        artifactOutputs: [],
      },
    },
    evidence: [{ id: "ev-1", kind: "output", text: "A long evidence summary that should not be dumped inline.", ts: recent }],
  });
  const lines = renderLines([completed], passthroughTheme, 0, 200);
  const line = lines.find((l) => l.includes("#1"));
  assert.ok(line);
  assert.match(line!, /output saved → \/tmp\/async-out\.md/);
  // The widget must not dump the evidence/output content inline.
  assert.doesNotMatch(line!, /A long evidence summary/);
});

test("renderLines keeps the evidence line for completed async runs without saved output", () => {
  const recent = new Date(Date.now() - 5_000).toISOString();
  const completed = task("1", "completed", {
    updatedAt: recent,
    run: {
      id: "task-1-run",
      taskId: "1",
      status: "completed",
      agent: "worker",
      startedAt: recent,
      finishedAt: recent,
      subagent: { agent: "worker", asyncId: "async-1", sessionFiles: [], savedOutputs: [], artifactOutputs: [] },
    },
    evidence: [{ id: "ev-1", kind: "output", text: "evidence summary", ts: recent }],
  });
  const lines = renderLines([completed], passthroughTheme, 0, 200);
  const line = lines.find((l) => l.includes("#1"))!;
  assert.match(line, /evidence summary/);
  assert.doesNotMatch(line, /output saved →/);
});
