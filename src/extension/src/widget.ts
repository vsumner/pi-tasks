import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, primarySavedOutput, runOutputPaths, statusIcon, taskStats } from "./format.ts";
import type { taskStore } from "./task-store.ts";
import { isTaskBlocked, readyTasks, type TaskItem, type TaskStatus } from "./task-state.ts";

export interface TaskWidgetRuntime {
  latestCtx: ExtensionContext | null;
  widgetTimer: ReturnType<typeof setInterval> | null;
  widgetFrame: number;
}

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const DEFAULT_MAX_VISIBLE = 10;
export const RECENT_COMPLETED_TTL_MS = 30_000;
export const COMPLETED_ONLY_HIDE_MS = 5_000;

// Display priority buckets, lowest rank renders first. Mirrors the Claude
// task-list order adapted for Pi's richer status model: recent completed is
// surfaced briefly, then active work, then ready/blocked pending, terminal
// states, and finally stale completed at the bottom.
const RECENT_COMPLETED_RANK = 0;
const IN_PROGRESS_RANK = 1;
const READY_PENDING_RANK = 2;
const BLOCKED_RANK = 3;
const TERMINAL_RANK = 4;
const OLD_COMPLETED_RANK = 5;

function byId(a: TaskItem, b: TaskItem): number {
  const numeric = Number(a.id) - Number(b.id);
  if (Number.isFinite(numeric) && numeric !== 0) return numeric;
  return a.id.localeCompare(b.id);
}

function displayRank(task: TaskItem, all: TaskItem[], nowMs: number): number {
  switch (task.status) {
    case "completed":
      return isRecentlyCompleted(task, nowMs) ? RECENT_COMPLETED_RANK : OLD_COMPLETED_RANK;
    case "in_progress":
      return IN_PROGRESS_RANK;
    case "pending":
      return isTaskBlocked(task, all) ? BLOCKED_RANK : READY_PENDING_RANK;
    case "blocked":
      return BLOCKED_RANK;
    case "failed":
    case "cancelled":
      return TERMINAL_RANK;
  }
}

function sortByDisplayRank(tasks: TaskItem[], nowMs: number): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const rankA = displayRank(a, tasks, nowMs);
    const rankB = displayRank(b, tasks, nowMs);
    if (rankA !== rankB) return rankA - rankB;
    return byId(a, b);
  });
}

function sortStableById(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort(byId);
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
  // Completed async/background runs that saved an output file get a compact
  // "output saved → <path>" hint instead of dumping the evidence/output content
  // inline. Other completed tasks keep showing the last evidence line.
  const savedOutputPath = task.status === "completed" && task.run?.subagent.asyncId
    ? primarySavedOutput(runOutputPaths(task.run?.subagent))
    : undefined;
  const latestEvidence = !savedOutputPath && task.status === "completed" ? task.evidence.at(-1)?.text : undefined;
  const proof = savedOutputPath
    ? theme.fg("dim", ` › output saved → ${savedOutputPath}`)
    : latestEvidence ? theme.fg("dim", ` › ${latestEvidence.replace(/\s+/g, " ").slice(0, 80)}`) : "";

  return truncateToWidth(`  ${icon} ${id} ${title}${owner}${stats}${blocked}${proof}`, width);
}

const HIDDEN_SUMMARY_ORDER: ReadonlyArray<TaskStatus> = [
  "in_progress",
  "pending",
  "blocked",
  "failed",
  "cancelled",
  "completed",
];

function hiddenStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "in_progress": return "active";
    case "pending": return "open";
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "completed": return "done";
  }
}

export function hiddenSummary(tasks: TaskItem[]): string {
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const parts: string[] = [];
  for (const status of HIDDEN_SUMMARY_ORDER) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${hiddenStatusLabel(status)}`);
  }
  return parts.join(", ");
}

export function isRecentlyCompleted(task: TaskItem, nowMs: number): boolean {
  if (task.status !== "completed") return true;
  const updatedAt = Date.parse(task.updatedAt);
  return Number.isFinite(updatedAt) && nowMs - updatedAt <= RECENT_COMPLETED_TTL_MS;
}

function isCompletedOnlyStillVisible(task: TaskItem, nowMs: number): boolean {
  const updatedAt = Date.parse(task.updatedAt);
  return Number.isFinite(updatedAt) && nowMs - updatedAt <= COMPLETED_ONLY_HIDE_MS;
}

export interface WidgetPlan {
  sorted: TaskItem[];
  visible: TaskItem[];
  hidden: TaskItem[];
}

/**
 * Decide which tasks the compact widget should show. Returns null when there
 * is nothing worth rendering: no tasks at all, or only completed tasks older
 * than Claude's completed-only hide delay with nothing else going on.
 * Canonical task state is never mutated here — this is a pure display
 * projection over the session-backed store. Normal-sized lists stay in stable
 * ID order; priority buckets are only used when truncating, matching Claude's
 * TaskListV2 behavior.
 */
export function planWidget(
  tasks: TaskItem[],
  nowMs: number = Date.now(),
  maxVisible: number = DEFAULT_MAX_VISIBLE,
): WidgetPlan | null {
  if (tasks.length === 0) return null;
  const hasOpenWork = tasks.some((task) => task.status !== "completed");
  // Only completed tasks remain and the brief completion window expired → hide
  // the widget entirely without deleting canonical task state.
  if (!hasOpenWork && !tasks.some((task) => isCompletedOnlyStillVisible(task, nowMs))) return null;
  const sorted = tasks.length > maxVisible ? sortByDisplayRank(tasks, nowMs) : sortStableById(tasks);
  return { sorted, visible: sorted.slice(0, maxVisible), hidden: sorted.slice(maxVisible) };
}

export function renderLines(tasks: TaskItem[], theme: Theme, frame: number, width: number): string[] {
  const plan = planWidget(tasks, Date.now());
  if (!plan) return [];
  const maxW = Math.max(1, width);
  const readyCount = readyTasks(tasks).length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const headerBits = [taskStats(tasks)];
  if (readyCount) headerBits.push(`${readyCount} ready`);
  if (failedCount) headerBits.push(`${failedCount} failed`);
  const header = truncateToWidth(`${theme.fg("accent", "●")} ${theme.fg("accent", headerBits.join(" · "))}`, maxW);
  const lines = [header, ...plan.visible.map((task) => renderTask(task, tasks, theme, frame, maxW))];
  if (plan.hidden.length > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `    … and ${plan.hidden.length} more (${hiddenSummary(plan.hidden)})`), maxW));
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

  function repaint(ctx: ExtensionContext, rt: TaskWidgetRuntime): void {
    try {
      ctx.ui.setWidget("pi-tasks", makeWidget(ctx, rt), { placement: "aboveEditor" });
    } catch {
      // UI may be stale during session replacement.
    }
  }

  function needsTimer(tasks: TaskItem[], nowMs: number): boolean {
    return tasks.some((task) => task.status === "in_progress")
      || tasks.some((task) => task.status === "completed" && isRecentlyCompleted(task, nowMs));
  }

  function refresh(ctx: ExtensionContext): void {
    const rt = getRuntime(ctx);
    rt.latestCtx = ctx;
    if (!ctx.hasUI) return;

    const nowMs = Date.now();
    const tasks = store.readAll(storeKey(ctx));

    // Hide the widget when there is nothing worth showing (no tasks, or only
    // stale completed tasks). Canonical task state is left untouched.
    if (!planWidget(tasks, nowMs)) {
      clear(ctx, rt);
      return;
    }

    // Keep the animation/refresh timer alive while there is active work or a
    // recent completion that will expire (~30s). Without this, a task that
    // completes with nothing else running would freeze on screen forever.
    if (needsTimer(tasks, nowMs)) {
      if (!rt.widgetTimer) {
        rt.widgetTimer = setInterval(() => {
          const latest = rt.latestCtx;
          if (!latest?.hasUI) return;
          rt.widgetFrame++;
          const current = store.readAll(storeKey(latest));
          const currentMs = Date.now();
          // Stale-completed-only (or emptied) state → hide and stop ticking.
          if (!planWidget(current, currentMs)) {
            clear(latest, rt);
            return;
          }
          // Recent completion expired and nothing is active → final repaint,
          // then stop the timer so it does not spin idly.
          if (!needsTimer(current, currentMs) && rt.widgetTimer) {
            clearInterval(rt.widgetTimer);
            rt.widgetTimer = null;
          }
          repaint(latest, rt);
        }, 150);
      }
    } else if (rt.widgetTimer) {
      clearInterval(rt.widgetTimer);
      rt.widgetTimer = null;
    }

    repaint(ctx, rt);
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
