import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, formatOutputFilesSection, formatTaskLine, hasRunOutputFiles, outputReadHint, primarySavedOutput, runOutputPaths, statusIcon, statusRank, taskStats, textBlock, unresolvedBlockers } from "../../src/extension/src/format.ts";
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

test("formatTaskLine includes owner and unresolved blockers", () => {
  assert.equal(
    formatTaskLine(task("2", "blocked", { title: "Deploy", owner: "alice", blockedBy: ["1", "3"] })),
    "#2 [blocked] Deploy (alice) [blocked by #1, #3]",
  );

  const blocker = task("1", "completed");
  const openBlocker = task("3", "pending");
  const target = task("2", "blocked", { title: "Deploy", owner: "alice", blockedBy: ["1", "3"] });
  assert.deepEqual(unresolvedBlockers(target, [blocker, target, openBlocker]), ["3"]);
  assert.equal(
    formatTaskLine(target, [blocker, target, openBlocker]),
    "#2 [blocked] Deploy (alice) [blocked by #3]",
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

test("runOutputPaths dedupes and ignores non-string entries", () => {
  assert.deepEqual(runOutputPaths(undefined), { savedOutputs: [], artifactOutputs: [], sessionFiles: [] });
  assert.deepEqual(runOutputPaths(null), { savedOutputs: [], artifactOutputs: [], sessionFiles: [] });
  assert.deepEqual(
    runOutputPaths({ savedOutputs: ["/a.md", "/a.md", ""], artifactOutputs: ["/b.md"], sessionFiles: ["/c.jsonl"] }),
    { savedOutputs: ["/a.md"], artifactOutputs: ["/b.md"], sessionFiles: ["/c.jsonl"] },
  );
});

test("hasRunOutputFiles and primarySavedOutput cover empty and populated cases", () => {
  const empty = runOutputPaths(undefined);
  assert.equal(hasRunOutputFiles(empty), false);
  assert.equal(primarySavedOutput(empty), undefined);

  const onlySession = runOutputPaths({ savedOutputs: [], artifactOutputs: [], sessionFiles: ["/s.jsonl"] });
  assert.equal(hasRunOutputFiles(onlySession), true);
  assert.equal(primarySavedOutput(onlySession), undefined);

  const withArtifact = runOutputPaths({ savedOutputs: [], artifactOutputs: ["/art.md"], sessionFiles: [] });
  assert.equal(primarySavedOutput(withArtifact), "/art.md");

  const withSaved = runOutputPaths({ savedOutputs: ["/out.md"], artifactOutputs: ["/art.md"], sessionFiles: [] });
  assert.equal(primarySavedOutput(withSaved), "/out.md");
});

test("formatOutputFilesSection leads with saved output and lists all groups", () => {
  const paths = runOutputPaths({
    savedOutputs: ["/tmp/out.md"],
    artifactOutputs: ["/tmp/artifact.md"],
    sessionFiles: ["/tmp/session.jsonl"],
  });

  const section = formatOutputFilesSection(paths);
  assert.ok(section);
  assert.match(section!, /^## Output files\n/);
  assert.match(section!, /Saved output — read this file for the full result:\n  \/tmp\/out\.md/);
  assert.match(section!, /Artifact output:\n  \/tmp\/artifact\.md/);
  assert.match(section!, /Subagent session transcript \(reference only\):\n  \/tmp\/session\.jsonl/);
  // Saved output guidance precedes artifacts and the session transcript.
  assert.ok(section!.indexOf("/tmp/out.md") < section!.indexOf("Artifact output"));
});

test("formatOutputFilesSection returns undefined when no paths are recorded", () => {
  assert.equal(formatOutputFilesSection(runOutputPaths(undefined)), undefined);
  assert.equal(formatOutputFilesSection(runOutputPaths({ savedOutputs: [], artifactOutputs: [], sessionFiles: [] })), undefined);
});

test("outputReadHint points at saved output and falls back to session transcript", () => {
  assert.equal(outputReadHint(runOutputPaths(undefined)), undefined);
  assert.equal(
    outputReadHint(runOutputPaths({ savedOutputs: ["/out.md"], artifactOutputs: [], sessionFiles: ["/s.jsonl"] })),
    "output saved to /out.md; read it for the full result",
  );
  assert.equal(
    outputReadHint(runOutputPaths({ savedOutputs: [], artifactOutputs: ["/art.md"], sessionFiles: [] })),
    "output saved to /art.md; read it for the full result",
  );
  assert.equal(
    outputReadHint(runOutputPaths({ savedOutputs: [], artifactOutputs: [], sessionFiles: ["/s.jsonl"] })),
    "session transcript at /s.jsonl",
  );
});
