import test from "node:test";
import assert from "node:assert/strict";
import { responseIsError, resultIsFailed, subagentRefFromResponse, subagentRunStatus, summarizeSubagentResponse, usageFromResponse, type SlashSubagentResponseLike } from "../../src/extension/src/subagents.ts";

test("subagent response helpers extract references and usage", () => {
  const response: SlashSubagentResponseLike = {
    requestId: "req-1",
    isError: false,
    result: {
      content: [{ type: "text", text: "done" }],
      details: {
        runId: "run-1",
        asyncId: "async-1",
        asyncDir: "/tmp/run",
        results: [{ agent: "worker", sessionFile: "/tmp/s.jsonl", savedOutputPath: "/tmp/out.md", usage: { input: 10, output: 5, turns: 1, cost: 0.01 } }],
      },
    },
  };

  assert.equal(summarizeSubagentResponse(response), "done");
  assert.equal(subagentRunStatus(response, true), "detached");
  assert.deepEqual(subagentRefFromResponse(response.requestId, response), {
    requestId: "req-1",
    runId: "run-1",
    asyncId: "async-1",
    asyncDir: "/tmp/run",
    agent: "worker",
    sessionFiles: ["/tmp/s.jsonl"],
    savedOutputs: ["/tmp/out.md"],
    artifactOutputs: [],
  });
  assert.deepEqual(usageFromResponse(response), { input: 10, output: 5, total: 15, turns: 1, cost: 0.01 });
});

test("responseIsError flags bridge-level failures on both strict and loose response shapes", () => {
  assert.equal(responseIsError({ isError: true, result: {} }), true);
  assert.equal(responseIsError({ isError: false, result: { isError: true } }), true);
  assert.equal(responseIsError({ isError: false, result: { isError: false } }), false);
  assert.equal(responseIsError({}), false);
});

test("resultIsFailed treats missing result as failed (parallel missing-child parity)", () => {
  assert.equal(resultIsFailed(undefined), true);
  assert.equal(resultIsFailed({}), false);
  assert.equal(resultIsFailed({ exitCode: 0 }), false);
  assert.equal(resultIsFailed({ exitCode: 1 }), true);
  assert.equal(resultIsFailed({ exitCode: 0, error: "boom" }), true);
  assert.equal(resultIsFailed({ exitCode: 0, error: "" }), false);
});

test("subagentRunStatus detaches only when requested async or the bridge reports detached results", () => {
  const base = (results: Array<Record<string, unknown>>): SlashSubagentResponseLike => ({
    requestId: "r",
    isError: false,
    result: { content: [], details: { results } },
  });
  assert.equal(subagentRunStatus(base([{ exitCode: 0 }]), false), "completed");
  assert.equal(subagentRunStatus(base([{ exitCode: 2 }]), false), "failed");
  assert.equal(subagentRunStatus(base([{ detached: true }]), false), "detached");
  assert.equal(subagentRunStatus(base([{ exitCode: 0 }]), true), "detached");
});
