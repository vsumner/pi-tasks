// Regression coverage for the run-engine pure helpers that were previously
// private and untested. The most important is parseAsyncSummaryStatus: it
// free-text-parses a pi-subagents status summary to decide whether an async
// task completed, and a silent parse miss leaves the task in_progress forever.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canRun,
  classifyRunError,
  hasVerificationEvidence,
  parseAsyncSummaryStatus,
  resultStatus,
} from "../../src/extension/src/task-run-engine.ts";
import type { TaskItem } from "../../src/extension/src/task-state.ts";

function task(over: Partial<TaskItem> = {}): TaskItem {
  return {
    id: "1",
    title: "t",
    prompt: "p",
    status: "pending",
    kind: "subagent",
    source: "agent",
    blockedBy: [],
    blocks: [],
    metadata: {},
    evidence: [],
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

describe("classifyRunError", () => {
  it("maps cancellation vocabulary to cancelled", () => {
    assert.equal(classifyRunError("Task subagent run cancelled."), "cancelled");
    assert.equal(classifyRunError("operation canceled by user"), "cancelled");
    assert.equal(classifyRunError("Request aborted"), "cancelled");
  });
  it("maps any other error to failed", () => {
    assert.equal(classifyRunError("ENOENT: no such file"), "failed");
    assert.equal(classifyRunError("timeout"), "failed");
    assert.equal(classifyRunError(""), "failed");
  });
  it("is case-insensitive", () => {
    assert.equal(classifyRunError("CANCELLED"), "cancelled");
    assert.equal(classifyRunError("Aborted"), "cancelled");
  });
});

describe("parseAsyncSummaryStatus", () => {
  it("recognizes terminal success states", () => {
    for (const s of ["complete", "completed", "success", "succeeded"]) {
      assert.equal(parseAsyncSummaryStatus(`State: ${s}`).status, "completed", s);
    }
  });
  it("recognizes terminal failure states", () => {
    for (const s of ["failed", "failure", "error"]) {
      assert.equal(parseAsyncSummaryStatus(`State: ${s}`).status, "failed", s);
    }
  });
  it("recognizes cancellation states", () => {
    for (const s of ["cancelled", "canceled", "interrupted"]) {
      assert.equal(parseAsyncSummaryStatus(`State: ${s}`).status, "cancelled", s);
    }
  });
  it("treats non-terminal states as still-running (no status, no warning)", () => {
    for (const s of ["queued", "running", "detached", "pending", "active", "in_progress"]) {
      const r = parseAsyncSummaryStatus(`State: ${s}`);
      assert.equal(r.status, undefined, s);
      assert.equal(r.warning, undefined, s);
    }
  });
  it("is case-insensitive on the state token", () => {
    assert.equal(parseAsyncSummaryStatus("state: COMPLETED").status, "completed");
    assert.equal(parseAsyncSummaryStatus("STATE: Failed").status, "failed");
  });
  it("returns a warning (and no status) when there is no State: token", () => {
    const r = parseAsyncSummaryStatus("some free text without a state marker");
    assert.equal(r.status, undefined);
    assert.ok(r.warning, "expected a warning so callers know nothing changed");
  });
  it("returns a warning for an unrecognized state token", () => {
    const r = parseAsyncSummaryStatus("State: frobnicated");
    assert.equal(r.status, undefined);
    assert.ok(r.warning);
    assert.match(r.warning!, /frobnicated/);
  });
});

describe("canRun", () => {
  it("allows any task when force is set, even terminal or blocked", () => {
    assert.equal(canRun(task({ status: "completed" }), [], true), undefined);
    assert.equal(canRun(task({ status: "pending", blockedBy: ["9"] }), [task({ id: "9", status: "pending" })], true), undefined);
  });
  it("rejects non-pending tasks", () => {
    assert.match(canRun(task({ status: "in_progress" }), [], undefined)!, /not pending/);
  });
  it("rejects pending tasks with unresolved blockers", () => {
    const all = [task({ id: "2", blockedBy: ["1"] }), task({ id: "1", status: "pending" })];
    assert.match(canRun(all[0], all, false)!, /blocked by #1/);
  });
  it("allows pending tasks whose blockers are completed", () => {
    const all = [task({ id: "2", blockedBy: ["1"] }), task({ id: "1", status: "completed" })];
    assert.equal(canRun(all[0], all, false), undefined);
  });
});

describe("resultStatus", () => {
  it("is failed when the response is an error", () => {
    assert.equal(resultStatus({ isError: true }, undefined), "failed");
    assert.equal(resultStatus({ result: { isError: true } }, { agent: "x" }), "failed");
  });
  it("is failed when a child result is missing or exited non-zero", () => {
    assert.equal(resultStatus({}, undefined), "failed");
    assert.equal(resultStatus({}, { exitCode: 1 } as never), "failed");
    assert.equal(resultStatus({}, { error: "boom" } as never), "failed");
  });
  it("is completed for a clean child result with no error", () => {
    assert.equal(resultStatus({}, { exitCode: 0, finalOutput: "ok" } as never), "completed");
  });
});

describe("hasVerificationEvidence", () => {
  it("is true when proof/review evidence or passed=true is recorded", () => {
    assert.equal(hasVerificationEvidence(task({ evidence: [{ id: "e", kind: "proof", text: "t", ts: "t" }] })), true);
    assert.equal(hasVerificationEvidence(task({ evidence: [{ id: "e", kind: "review", text: "t", ts: "t" }] })), true);
    assert.equal(hasVerificationEvidence(task({ evidence: [{ id: "e", kind: "output", text: "t", ts: "t", passed: true }] })), true);
  });
  it("is false for plain output/note evidence", () => {
    assert.equal(hasVerificationEvidence(task({ evidence: [{ id: "e", kind: "output", text: "t", ts: "t" }] })), false);
    assert.equal(hasVerificationEvidence(task()), false);
  });
  it("honors acceptance level strings", () => {
    assert.equal(hasVerificationEvidence(task({ acceptance: "verified" })), true);
    assert.equal(hasVerificationEvidence(task({ acceptance: "auto" })), false);
  });
  it("honors acceptance config level and verify[] presence", () => {
    assert.equal(hasVerificationEvidence(task({ acceptance: { level: "checked" } })), true);
    assert.equal(hasVerificationEvidence(task({ acceptance: { verify: [{ id: "v", command: "npm test" }] } })), true);
    assert.equal(hasVerificationEvidence(task({ acceptance: { level: "none" } })), false);
  });
});
