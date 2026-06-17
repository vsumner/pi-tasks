import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { TASK_UPDATED_EVENT } from "./events.ts";
import { formatTaskLine, statusIcon, taskStats, textBlock } from "./format.ts";
import type { taskStore } from "./task-store.ts";
import type { TaskItem, TaskStatus } from "./task-state.ts";
import {
  getTaskOutput,
  getTaskStatus,
  resumeTask,
  retryTask,
  runTasks,
  stopTask,
  waitForTask,
  type TaskChangeHandler,
} from "./task-run-engine.ts";

class TaskListComponent {
  private tasks: TaskItem[];
  private allTasks: TaskItem[];
  private theme: Theme;
  private onClose: () => void;
  private title: string;

  constructor(tasks: TaskItem[], theme: Theme, onClose: () => void, title = "Tasks", allTasks: TaskItem[] = tasks) {
    this.tasks = tasks;
    this.allTasks = allTasks;
    this.theme = theme;
    this.onClose = onClose;
    this.title = title;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [""];
    const title = th.fg("accent", ` ${this.title} `);
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.title.length - 6))), width));
    lines.push("");
    if (this.tasks.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No tasks on this branch.")}`, width));
    } else {
      lines.push(truncateToWidth(`  ${th.fg("muted", taskStats(this.tasks))}`, width));
      lines.push("");
      for (const task of this.tasks) {
        const rawIcon = statusIcon(task.status);
        const icon = task.status === "completed" ? th.fg("success", rawIcon)
          : task.status === "in_progress" ? th.fg("accent", rawIcon)
          : task.status === "blocked" ? th.fg("warning", rawIcon)
          : task.status === "failed" ? th.fg("error", rawIcon)
          : task.status === "cancelled" ? th.fg("dim", rawIcon)
          : th.fg("muted", rawIcon);
        const formatted = formatTaskLine(task, this.allTasks);
        const line = task.status === "completed"
          ? `  ${icon} ${th.fg("dim", th.strikethrough(formatted))}`
          : `  ${icon} ${formatted}`;
        lines.push(truncateToWidth(line, width));
      }
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
    lines.push("");
    return lines;
  }

  invalidate(): void {}
}

function tokenize(args: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(args)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}

function flag(tokens: string[], name: string): boolean {
  return tokens.includes(name);
}

function flagValue(tokens: string[], name: string): string | undefined {
  const index = tokens.indexOf(name);
  if (index < 0) return undefined;
  return tokens[index + 1];
}

function idsFrom(tokens: string[]): string[] {
  return tokens.filter((token) => /^\d+$/.test(token));
}

function requireId(ctx: ExtensionContext, action: string, id: string | undefined): id is string {
  if (id) return true;
  notify(ctx, `Usage: /tasks ${action} <id>`, "warning");
  return false;
}

function commandText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return textBlock(result.content) || "Done.";
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): string {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  return text;
}

function notifyList(ctx: ExtensionContext, tasks: TaskItem[], title = "Tasks", allTasks: TaskItem[] = tasks): string {
  const text = tasks.length > 0 ? tasks.map((task) => formatTaskLine(task, allTasks)).join("\n") : "No tasks on this branch.";
  if (ctx.hasUI) ctx.ui.notify(`${title}:\n${text}`, "info");
  return text;
}

function statusFilterFor(action: string): TaskStatus | undefined {
  switch (action) {
    case "active": return "in_progress";
    case "failed": return "failed";
    case "completed": return "completed";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    case "pending": return "pending";
    default: return undefined;
  }
}

export function registerTaskCommands(
  pi: ExtensionAPI,
  store: typeof taskStore,
  refreshWidget: (ctx: ExtensionContext) => void,
  storeKey: (ctx: ExtensionContext) => string = (ctx) => ctx.cwd,
  onTaskChanged: TaskChangeHandler = () => {},
): void {
  pi.registerCommand("tasks", {
    description: "Manage pi-tasks. Args: list|ready|active|failed|run|claim|status|output|stop|resume|retry|wait|snapshot|clear-completed|clear-all",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const tokens = tokenize(raw);
      const action = tokens.shift() ?? "list";
      const scope = storeKey(ctx);

      if (action === "clear-completed") {
        const count = store.clearCompleted(scope);
        refreshWidget(ctx);
        notify(ctx, `Cleared ${count} completed task${count === 1 ? "" : "s"}.`);
        return;
      }
      if (action === "clear-all") {
        const ok = ctx.hasUI ? await ctx.ui.confirm("Clear all tasks?", "This removes all tasks from the current session branch projection.") : false;
        if (!ok) {
          notify(ctx, "Task clear-all cancelled.");
          return;
        }
        const count = store.clearAll(scope);
        refreshWidget(ctx);
        notify(ctx, `Cleared ${count} task${count === 1 ? "" : "s"}.`);
        return;
      }
      if (action === "snapshot") {
        const count = store.snapshot(scope);
        refreshWidget(ctx);
        notify(ctx, `Recorded task snapshot with ${count} task${count === 1 ? "" : "s"}.`);
        return;
      }

      if (action === "run") {
        const ids = idsFrom(tokens);
        const concurrencyRaw = flagValue(tokens, "--concurrency");
        const result = await runTasks(pi, ctx, {
          task_ids: ids.length > 1 ? ids : undefined,
          taskId: ids.length === 1 ? ids[0] : undefined,
          ready: tokens.includes("ready") || ids.length === 0,
          async: flag(tokens, "--async"),
          parallel: flag(tokens, "--parallel"),
          concurrency: concurrencyRaw ? Number(concurrencyRaw) : undefined,
          force: flag(tokens, "--force"),
        }, undefined, onTaskChanged, undefined, store);
        refreshWidget(ctx);
        notify(ctx, commandText(result));
        return;
      }

      if (action === "status") {
        const id = tokens.find((token) => /^\d+$/.test(token));
        const result = await getTaskStatus(pi, ctx, { taskId: id, refresh: !flag(tokens, "--no-refresh") }, undefined, onTaskChanged, store);
        refreshWidget(ctx);
        notify(ctx, commandText(result));
        return;
      }

      if (action === "output") {
        const id = tokens.find((token) => /^\d+$/.test(token));
        if (!requireId(ctx, action, id)) return;
        const result = await getTaskOutput(pi, ctx, { taskId: id, refresh: !flag(tokens, "--no-refresh") }, undefined, onTaskChanged, store);
        refreshWidget(ctx);
        notify(ctx, commandText(result));
        return;
      }

      if (action === "stop") {
        const id = tokens.find((token) => /^\d+$/.test(token));
        if (!requireId(ctx, action, id)) return;
        const result = await stopTask(pi, ctx, { taskId: id }, undefined, onTaskChanged, store);
        refreshWidget(ctx);
        notify(ctx, commandText(result));
        return;
      }

      if (action === "resume") {
        const id = tokens.find((token) => /^\d+$/.test(token));
        if (!requireId(ctx, action, id)) return;
        const idIndex = tokens.indexOf(id);
        const message = idIndex >= 0 ? tokens.slice(idIndex + 1).join(" ") : undefined;
        const result = await resumeTask(pi, ctx, { taskId: id, message }, undefined, onTaskChanged, store);
        refreshWidget(ctx);
        notify(ctx, commandText(result));
        return;
      }

      if (action === "retry") {
        const id = tokens.find((token) => /^\d+$/.test(token));
        if (!requireId(ctx, action, id)) return;
        const result = await retryTask(pi, ctx, { taskId: id, async: flag(tokens, "--async"), force: flag(tokens, "--force") }, undefined, onTaskChanged, undefined, store);
        refreshWidget(ctx);
        notify(ctx, commandText(result));
        return;
      }

      if (action === "wait") {
        const id = tokens.find((token) => /^\d+$/.test(token));
        if (!requireId(ctx, action, id)) return;
        const timeout = flagValue(tokens, "--timeout-ms");
        const poll = flagValue(tokens, "--poll-ms");
        const result = await waitForTask(pi, ctx, { taskId: id, timeout_ms: timeout ? Number(timeout) : undefined, poll_ms: poll ? Number(poll) : undefined }, undefined, onTaskChanged, store);
        refreshWidget(ctx);
        notify(ctx, commandText(result));
        return;
      }

      if (action === "claim") {
        const id = tokens.find((token) => /^\d+$/.test(token));
        if (!requireId(ctx, action, id)) return;
        const idIndex = tokens.indexOf(id);
        const afterId = tokens.slice(idIndex + 1);
        const rawOwner = afterId.find((t) => !t.startsWith("-"));
        const owner = rawOwner === undefined ? "user" : rawOwner.trim();
        const start = flag(tokens, "--start");
        const result = store.claimTask(scope, id, {
          owner,
          start,
          force: flag(tokens, "--force"),
          oneOpenPerOwner: flag(tokens, "--one-open-per-owner"),
        });
        refreshWidget(ctx);
        if (result.success) {
          onTaskChanged(ctx, TASK_UPDATED_EVENT, { taskId: id });
          notify(ctx, `Claimed task #${id} for ${result.task?.owner ?? owner}${start ? " (in_progress)" : ""}.`);
        } else {
          const detail = result.blockedByTasks?.length ? ` (blocked by ${result.blockedByTasks.map((bid) => `#${bid}`).join(", ")})` : "";
          const busy = result.busyWithTasks?.length ? ` (owner busy with ${result.busyWithTasks.map((bid) => `#${bid}`).join(", ")})` : "";
          notify(ctx, `Claim failed for task #${id}: ${result.reason}${detail}${busy}`, "warning");
        }
        return;
      }

      const statusFilter = statusFilterFor(action);
      const allTasks = store.readAll(scope);
      const tasks = action === "ready"
        ? store.ready(scope)
        : statusFilter
          ? allTasks.filter((task) => task.status === statusFilter)
          : allTasks;
      const title = action === "ready" ? "Ready tasks" : statusFilter ? `${action[0]?.toUpperCase() ?? ""}${action.slice(1)} tasks` : "Tasks";
      if (ctx.mode !== "tui") {
        notifyList(ctx, tasks, title, allTasks);
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TaskListComponent(tasks, theme, () => done(), title, allTasks));
      void tasks;
      return;
    },
  });
}
