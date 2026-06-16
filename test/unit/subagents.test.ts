import test from "node:test";
import assert from "node:assert/strict";
import { subagentRefFromResponse, subagentRunStatus, summarizeSubagentResponse, usageFromResponse, type SlashSubagentResponseLike } from "../../src/extension/src/subagents.ts";

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
