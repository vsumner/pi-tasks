import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, statusIcon, taskStats } from "./format.ts";
import type { taskStore } from "./task-store.ts";
import { readyTasks, type TaskItem } from "./task-state.ts";

export interface TaskWidgetRuntime {
  latestCtx: ExtensionContext | null;
  widgetTimer: ReturnType<typeof setInterval> | null;
  widgetFrame: number;
}

type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const DEFAULT_MAX_VISIBLE = 10;
const RECENT_COMPLETED_TTL_MS = 30_000;

function taskSort(a: TaskItem, b: TaskItem): number {
  const rank = (task: TaskItem) => {
    switch (task.status) {
      case "in_progress": return 0;
      case "pending": return 1;
      case "blocked": return 2;
      case "failed": return 3;
      case "completed": return 4;
      case "cancelled": return 5;
    }
  };
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  const numeric = Number(a.id) - Number(b.id);
  if (Number.isFinite(numeric) && numeric !== 0) return numeric;
  return a.id.localeCompare(b.id);
}

function activeElapsed(task: TaskItem): string | undefined {
  const started = task.run?.startedAt;
  if (!started) return undefined;
  const startMs = Date.parse(started);
  if (!Number.isFinite(startMs)) return undefined;
  return formatDuration(Date.now() - startMs);
}

function iconFor(task: TaskItem, theme: Theme, frame: number): string {
  if (task.status === "in_progress") return theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "✳");
  if (task.status === "completed") return theme.fg("success", statusIcon(task.status));
  if (task.status === "failed") return theme.fg("error", statusIcon(task.status));
  if (task.status === "blocked") return theme.fg("warning", statusIcon(task.status));
  if (task.status === "cancelled") return theme.fg("dim", statusIcon(task.status));
  return theme.fg("muted", statusIcon(task.status));
}

function renderTask(task: TaskItem, all: TaskItem[], theme: Theme, frame: number, width: number): string {
  const icon = iconFor(task, theme, frame);
  const id = theme.fg("dim", `#${task.id}`);
  const title = task.status === "completed"
    ? theme.fg("dim", theme.strikethrough(task.title))
    : task.status === "in_progress"
      ? theme.fg("accent", `${task.activeForm ?? task.title}…`)
      : task.title;

  const openBlockers = task.blockedBy.filter((id) => all.find((candidate) => candidate.id === id)?.status !== "completed");
  const blocked = openBlockers.length > 0
    ? theme.fg("dim", ` › blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}`)
    : "";
  const owner = task.owner && task.status === "in_progress" ? theme.fg("dim", ` (${task.owner.slice(0, 10)})`) : "";
  const asyncBadge = task.status === "in_progress" && (task.run?.status === "detached" || task.run?.subagent.asyncId) ? theme.fg("dim", " async") : "";
  const elapsed = task.status === "in_progress" ? activeElapsed(task) : undefined;
  const stats = elapsed ? theme.fg("dim", ` (${elapsed}${asyncBadge ? ", async" : ""})`) : asyncBadge;
  const latestEvidence = task.status === "completed" ? task.evidence.at(-1)?.text : undefined;
  const proof = latestEvidence ? theme.fg("dim", ` › ${latestEvidence.replace(/\s+/g, " ").slice(0, 80)}`) : "";

  return truncateToWidth(`  ${icon} ${id} ${title}${owner}${stats}${blocked}${proof}`, width);
}

function hiddenSummary(tasks: TaskItem[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return Array.from(counts.entries()).map(([status, count]) => `${count} ${status}`).join(", ");
}

function isRecentlyCompleted(task: TaskItem, nowMs: number): boolean {
  if (task.status !== "completed") return true;
  const updatedAt = Date.parse(task.updatedAt);
  return Number.isFinite(updatedAt) && nowMs - updatedAt <= RECENT_COMPLETED_TTL_MS;
}

function renderLines(tasks: TaskItem[], theme: Theme, frame: number, width: number): string[] {
  if (tasks.length === 0) return [];
  const maxW = Math.max(1, width);
  const sorted = [...tasks].sort(taskSort);
  const readyCount = readyTasks(sorted).length;
  const failedCount = sorted.filter((task) => task.status === "failed").length;
  const headerBits = [taskStats(sorted)];
  if (readyCount) headerBits.push(`${readyCount} ready`);
  if (failedCount) headerBits.push(`${failedCount} failed`);
  const header = truncateToWidth(`${theme.fg("accent", "●")} ${theme.fg("accent", headerBits.join(" · "))}`, maxW);
  const displayCandidates = sorted.filter((task) => isRecentlyCompleted(task, Date.now()));
  const visible = displayCandidates.slice(0, DEFAULT_MAX_VISIBLE);
  const hidden = sorted.filter((task) => !visible.some((v) => v.id === task.id));
  const lines = [header, ...visible.map((task) => renderTask(task, sorted, theme, frame, maxW))];
  if (hidden.length > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `    … and ${hidden.length} more (${hiddenSummary(hidden)})`), maxW));
  }
  return lines;
}

export function createTaskWidget(
  store: typeof taskStore,
  getRuntime: (ctx: ExtensionContext) => TaskWidgetRuntime,
  storeKey: (ctx: ExtensionContext) => string = (ctx) => ctx.cwd,
) {
  function clear(ctx: ExtensionContext, rt: TaskWidgetRuntime): void {
    if (rt.widgetTimer) {
      clearInterval(rt.widgetTimer);
      rt.widgetTimer = null;
    }
    if (ctx.hasUI) {
      try { ctx.ui.setWidget("pi-tasks", undefined); } catch { /* stale UI */ }
    }
  }

  function refresh(ctx: ExtensionContext): void {
    const rt = getRuntime(ctx);
    rt.latestCtx = ctx;
    if (!ctx.hasUI) return;

    const tasks = store.readAll(storeKey(ctx));
    if (tasks.length === 0) {
      clear(ctx, rt);
      return;
    }

    const hasActive = tasks.some((task) => task.status === "in_progress");
    if (hasActive && !rt.widgetTimer) {
      rt.widgetTimer = setInterval(() => {
        const latest = rt.latestCtx;
        if (!latest?.hasUI) return;
        rt.widgetFrame++;
        try { latest.ui.setWidget("pi-tasks", makeWidget(latest, rt), { placement: "aboveEditor" }); } catch { /* stale UI */ }
      }, 150);
    } else if (!hasActive && rt.widgetTimer) {
      clearInterval(rt.widgetTimer);
      rt.widgetTimer = null;
    }

    try {
      ctx.ui.setWidget("pi-tasks", makeWidget(ctx, rt), { placement: "aboveEditor" });
    } catch {
      // UI may be stale during session replacement.
    }
  }

  function makeWidget(ctx: ExtensionContext, rt: TaskWidgetRuntime) {
    return (_tui: unknown, theme: Theme) => ({
      render(width: number): string[] {
        return renderLines(store.readAll(storeKey(ctx)), theme, rt.widgetFrame, width);
      },
      invalidate() {},
    });
  }

  return { refresh, clear };
}
