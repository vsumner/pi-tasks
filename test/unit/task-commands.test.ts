import test from "node:test";
import assert from "node:assert/strict";
import { registerTaskCommands } from "../../src/extension/src/task-commands.ts";
import { taskStore } from "../../src/extension/src/task-store.ts";

function createCommandHarness(onTaskChanged: Parameters<typeof registerTaskCommands>[4] = () => {}) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    registerCommand(_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      handler = command.handler;
    },
    events: { on() { return () => {}; }, emit() {} },
  };
  registerTaskCommands(pi as any, taskStore, () => {}, () => "session-1", onTaskChanged);
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

  for (const action of ["output", "stop", "resume", "retry", "wait", "claim"]) {
    const { ctx, notifications } = createCtx();
    await handler(action, ctx);
    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.text ?? "", new RegExp(`Usage: /tasks ${action} <id>`));
  }
});

test("/tasks claim claims a task for the named owner", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const changes: Array<{ eventType: string; data?: Record<string, unknown> }> = [];
  const handler = createCommandHarness((_ctx, eventType, data) => changes.push({ eventType, data }));
  const task = taskStore.createTask("session-1", { title: "Claim me", prompt: "Work", cwd: "/repo" });

  const { ctx, notifications } = createCtx();
  await handler(`claim ${task.id} alice`, ctx);

  assert.match(notifications.at(-1)?.text ?? "", /Claimed task #1 for alice/);
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, "alice");
  assert.deepEqual(changes, [{ eventType: "pi-tasks:updated", data: { taskId: task.id } }]);
});

test("/tasks claim defaults owner to user when omitted", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const handler = createCommandHarness();
  const task = taskStore.createTask("session-1", { title: "Claim me", prompt: "Work", cwd: "/repo" });

  const { ctx, notifications } = createCtx();
  await handler(`claim ${task.id}`, ctx);

  assert.match(notifications.at(-1)?.text ?? "", /Claimed task #1 for user/);
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, "user");
});

test("/tasks claim --start sets status to in_progress", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const handler = createCommandHarness();
  const task = taskStore.createTask("session-1", { title: "Claim me", prompt: "Work", cwd: "/repo" });

  const { ctx } = createCtx();
  await handler(`claim ${task.id} alice --start`, ctx);

  assert.equal(taskStore.readTask("session-1", task.id)?.status, "in_progress");
});

test("/tasks claim reports failure for an already-owned task", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const handler = createCommandHarness();
  const task = taskStore.createTask("session-1", { title: "Owned", prompt: "Work", owner: "bob", cwd: "/repo" });

  const { ctx, notifications } = createCtx();
  await handler(`claim ${task.id} alice`, ctx);

  assert.equal(notifications.at(-1)?.level, "warning");
  assert.match(notifications.at(-1)?.text ?? "", /Claim failed for task #1: already_claimed/);
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, "bob");
});

test("/tasks claim rejects an explicitly blank owner", async () => {
  taskStore.reset();
  taskStore.setEventAppender(() => {});
  const handler = createCommandHarness();
  const task = taskStore.createTask("session-1", { title: "Claim me", prompt: "Work", cwd: "/repo" });

  const { ctx, notifications } = createCtx();
  await handler(`claim ${task.id} "   "`, ctx);

  assert.equal(notifications.at(-1)?.level, "warning");
  assert.match(notifications.at(-1)?.text ?? "", /Claim failed for task #1: invalid_owner/);
  assert.equal(taskStore.readTask("session-1", task.id)?.owner, undefined);
});
