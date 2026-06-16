import test from "node:test";
import assert from "node:assert/strict";
import { registerTaskCommands } from "../../src/extension/src/task-commands.ts";
import { taskStore } from "../../src/extension/src/task-store.ts";

function createCommandHarness() {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      handler = command.handler;
    },
    events: { on() { return () => {}; }, emit() {} },
  };
  registerTaskCommands(pi as any, taskStore, () => {}, () => "session-1", () => {});
  if (!handler) throw new Error("command not registered");
  return handler;
}

function createCtx() {
  const notifications: Array<{ text: string; level: string }> = [];
  return {
    notifications,
    ctx: {
      cwd: "/repo",
      mode: "json",
      hasUI: true,
      ui: {
        notify(text: string, level = "info") { notifications.push({ text, level }); },
        confirm: async () => false,
      },
      sessionManager: { getSessionId: () => "session-1" },
    },
  };
}

test("/tasks subcommands that require an id notify usage instead of throwing", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const handler = createCommandHarness();

  for (const action of ["output", "stop", "resume", "retry", "wait"]) {
    const { ctx, notifications } = createCtx();
    await handler(action, ctx);
    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.text ?? "", new RegExp(`Usage: /tasks ${action} <id>`));
  }
});
