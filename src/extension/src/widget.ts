import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, primarySavedOutput, runOutputPaths, statusIcon, taskStats } from "./format.ts";
import type { taskStore } from "./task-store.ts";
import { filterVisible, indexById, isTaskBlocked, readyTasksWithIndex, unresolvedBlockersById, type TaskActivity, type TaskItem, type TaskStatus } from "./task-state.ts";

export interface TaskWidgetRuntime {
  latestCtx: ExtensionContext | null;
  widgetTimer: ReturnType<typeof setInterval> | null;
  widgetFrame: number;
  /**
   * Cache for the sorted readAll projection, keyed by store version. The
   * 150ms animation timer re-renders every frame; without this cache every
   * idle tick cloned+sorted the full task array (and recomputed readyTasks /
   * planWidget) even when canonical state was unchanged. Invalidated
   * automatically when the store version advances on any mutation.
   */
  cachedVersion?: number;
  cachedTasks?: TaskItem[];
}

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const DEFAULT_MAX_VISIBLE = 10;

/**
 * Read the sorted task projection for a scope, reusing the cached array when
 * the store version has not advanced since the last read. The cache lives on
 * the per-scope widget runtime; renderers in this module never mutate task
 * objects (they build strings and sort copies), so sharing one cloned array
 * across a refresh + render + timer tick is safe.
 */
function readCachedTasks(store: typeof taskStore, rt: TaskWidgetRuntime, scope: string): TaskItem[] {
  const version = store.getVersion();
  if (rt.cachedVersion === version && rt.cachedTasks) return rt.cachedTasks;
  // Internal bookkeeping tasks (metadata._internal) never render in the
  // widget; filtering here keeps the cache visible-only so every consumer
  // (refresh hide-check, timer, render) shares one filtered array.
  const tasks = filterVisible(store.readAll(scope));
  rt.cachedTasks = tasks;
  rt.cachedVersion = version;
  return tasks;
}
export const RECENT_COMPLETED_TTL_MS = 30_000;
export const COMPLETED_ONLY_HIDE_MS = 5_000;
/** Live activity older than this is considered stale and not rendered. */
export const STALE_ACTIVITY_MS = 60_000;

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

function renderTask(task: TaskItem, statusById: Map<string, TaskItem>, theme: Theme, frame: number, width: number, activity?: TaskActivity, nowMs: number = Date.now()): string {
  const icon = iconFor(task, theme, frame);
  const id = theme.fg("dim", `#${task.id}`);
  const title = task.status === "completed"
    ? theme.fg("dim", theme.strikethrough(task.title))
    : task.status === "in_progress"
      ? theme.fg("accent", `${task.activeForm ?? task.title}…`)
      : task.title;

  const openBlockers = unresolvedBlockersById(task, statusById);
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

  const mainLine = truncateToWidth(`  ${icon} ${id} ${title}${owner}${stats}${blocked}${proof}`, width);
  // Live activity rollup (swarm-feel): a dim second line under an in_progress
  // task showing the agent's current tool, mirroring claude-src's per-teammate
  // summarizeRecentActivities ellipsis line. Only when fresh and not stale.
  if (task.status === "in_progress" && activity && activity.tool && nowMs - activity.ts <= STALE_ACTIVITY_MS) {
    const countLabel = activity.count > 0 ? ` · ${activity.count} tool${activity.count === 1 ? "" : "s"}` : "";
    const activityLine = truncateToWidth(theme.fg("dim", `    ${activity.tool}${countLabel}…`), width);
    return `${mainLine}\n${activityLine}`;
  }
  return mainLine;
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

export function renderLines(tasks: TaskItem[], theme: Theme, frame: number, width: number, activityByTaskId?: Map<string, TaskActivity>): string[] {
  const plan = planWidget(tasks, Date.now());
  if (!plan) return [];
  const maxW = Math.max(1, width);
  const nowMs = Date.now();
  // Build the status index once per frame and reuse it for both readiness
  // (readyTasksWithIndex) and per-row blocker rendering (unresolvedBlockersById)
  // — previously readiness rebuilt the full id index once per candidate task on
  // every 150ms repaint tick.
  const statusById = indexById(tasks);
  const ready = readyTasksWithIndex(tasks, statusById);
  const readyCount = ready.length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const headerBits = [taskStats(tasks)];
  if (readyCount) headerBits.push(`${readyCount} ready`);
  if (failedCount) headerBits.push(`${failedCount} failed`);
  const header = truncateToWidth(`${theme.fg("accent", "●")} ${theme.fg("accent", headerBits.join(" · "))}`, maxW);
  const lines = [header, ...plan.visible.flatMap((task) => renderTask(task, statusById, theme, frame, maxW, activityByTaskId?.get(task.id), nowMs).split("\n"))];
  if (plan.hidden.length > 0) {
    lines.push(truncateToWidth(theme.fg("dim", `    … and ${plan.hidden.length} more (${hiddenSummary(plan.hidden)})`), maxW));
  }
  // Mirror claude-src's Spinner "Next: <subject>" footer: when nothing is
  // in_progress, point at the lowest-ID ready task as the next action. Shown
  // only while idle so it does not compete with an active spinner.
  const hasActive = tasks.some((task) => task.status === "in_progress");
  const next = !hasActive ? ready[0] : undefined;
  if (next) {
    lines.push(truncateToWidth(theme.fg("dim", `    Next: ${next.activeForm ?? next.title}`), maxW));
  }
  return lines;
}

export function createTaskWidget(
  store: typeof taskStore,
  getRuntime: (ctx: ExtensionContext) => TaskWidgetRuntime,
  storeKey: (ctx: ExtensionContext) => string = (ctx) => ctx.cwd,
  activityFor?: (scope: string, taskId: string) => TaskActivity | undefined,
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
    const tasks = readCachedTasks(store, rt, storeKey(ctx));

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
          const current = readCachedTasks(store, rt, storeKey(latest));
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
        const scope = storeKey(ctx);
        const tasks = readCachedTasks(store, rt, scope);
        // Build the per-task activity map for this scope from the ephemeral
        // runtime store so renderTask can show the live tool line.
        const reader = activityFor;
        const activity = reader ? new Map<string, TaskActivity>() : undefined;
        if (activity && reader) for (const task of tasks) {
          const a = reader(scope, task.id);
          if (a) activity.set(task.id, a);
        }
        return renderLines(tasks, theme, rt.widgetFrame, width, activity);
      },
      invalidate() {},
    });
  }

  return { refresh, clear };
}
