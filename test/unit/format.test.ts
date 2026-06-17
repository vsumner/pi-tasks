import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, formatTaskLine, statusIcon, statusRank, taskStats, textBlock } from "../../src/extension/src/format.ts";
import { createTask, type TaskItem, type TaskStatus } from "../../src/extension/src/task-state.ts";

function task(id: string, status: TaskStatus, extra: Partial<TaskItem> = {}): TaskItem {
  return { ...createTask({ title: `Task ${id}`, prompt: `Prompt ${id}` }, id), status, ...extra };
}

test("statusIcon and statusRank cover the stored status model", () => {
  assert.deepEqual(
    ["in_progress", "pending", "blocked", "failed", "completed", "cancelled"].map((status) => [status, statusIcon(status as TaskStatus), statusRank(status as TaskStatus)]),
    [
      ["in_progress", "◼", 0],
      ["pending", "◻", 1],
      ["blocked", "⊘", 2],
      ["failed", "✖", 3],
      ["completed", "✔", 4],
      ["cancelled", "◌", 5],
    ],
  );
});

test("formatDuration renders seconds, minutes, and hours", () => {
  assert.equal(formatDuration(-1000), "0s");
  assert.equal(formatDuration(59_900), "59s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(3_660_000), "1h 1m");
});

test("formatTaskLine includes owner and blockers", () => {
  assert.equal(
    formatTaskLine(task("2", "blocked", { title: "Deploy", owner: "alice", blockedBy: ["1", "3"] })),
    "#2 [blocked] Deploy (alice) [blocked by #1, #3]",
  );
});

test("taskStats summarizes populated statuses", () => {
  const summary = taskStats([
    task("1", "completed"),
    task("2", "in_progress"),
    task("3", "pending"),
    task("4", "blocked"),
    task("5", "failed"),
    task("6", "cancelled"),
  ]);

  assert.equal(summary, "6 tasks (1 done, 1 active, 1 open, 1 blocked, 1 failed, 1 cancelled)");
  assert.equal(taskStats([task("1", "pending")]), "1 task (1 open)");
  assert.equal(taskStats([]), "0 tasks");
});

test("textBlock extracts text parts and ignores non-text content", () => {
  assert.equal(textBlock("already text"), "already text");
  assert.equal(textBlock(undefined), "");
  assert.equal(textBlock([
    { type: "text", text: "first" },
    { type: "image", text: "ignored" },
    { type: "text", text: "second" },
    { type: "text" },
  ]), "first\nsecond");
});
