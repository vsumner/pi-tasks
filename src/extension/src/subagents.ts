// ---------------------------------------------------------------------------
// pi-subagents bridge
//
// This package intentionally does not import pi-subagents internals. It uses
// the public-ish event bridge that pi-subagents exposes for slash/template
// runners. All execution/control requests are centralized here.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textBlock } from "./format.ts";
import type { TaskRunRecord, TaskRunStatus, TaskSubagentRef } from "./task-state.ts";

export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";

export interface SubagentParamsLike {
  action?: string;
  id?: string;
  runId?: string;
  dir?: string;
  index?: number;
  agent?: string;
  task?: string;
  message?: string;
  chain?: unknown[];
  tasks?: unknown[];
  concurrency?: number;
  worktree?: boolean;
  context?: "fresh" | "fork";
  async?: boolean;
  clarify?: boolean;
  share?: boolean;
  control?: Record<string, unknown>;
  sessionDir?: string;
  cwd?: string;
  maxOutput?: Record<string, unknown>;
  artifacts?: boolean;
  includeProgress?: boolean;
  model?: string;
  skill?: string | string[] | boolean;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  agentScope?: unknown;
  chainDir?: string;
  acceptance?: unknown;
}

export interface AgentToolResultLike {
  content: Array<{ type?: string; text?: string }>;
  details?: SubagentDetailsLike;
  isError?: boolean;
}

export interface SubagentDetailsLike {
  mode?: string;
  runId?: string;
  asyncId?: string;
  asyncDir?: string;
  results?: SubagentSingleResultLike[];
  progress?: unknown[];
  progressSummary?: unknown;
  controlEvents?: unknown[];
  [key: string]: unknown;
}

export interface SubagentSingleResultLike {
  agent?: string;
  exitCode?: number;
  detached?: boolean;
  detachedReason?: string;
  error?: string;
  sessionFile?: string;
  savedOutputPath?: string;
  artifactPaths?: { outputPath?: string };
  finalOutput?: string;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    turns?: number;
    cost?: number;
  };
  progress?: unknown;
  [key: string]: unknown;
}

export interface SlashSubagentResponseLike {
  requestId: string;
  result: AgentToolResultLike;
  isError: boolean;
  errorText?: string;
}

export interface SlashSubagentUpdateLike {
  requestId?: string;
  progress?: AgentProgressLike[];
  currentTool?: string;
  toolCount?: number;
}

/** Per-child progress entry streamed by pi-subagents in updates and responses. */
export interface AgentProgressLike {
  index: number;
  agent?: string;
  currentTool?: string;
  toolCount?: number;
  status?: string;
  [key: string]: unknown;
}

export interface SubagentBridgeCallbacks {
  onStarted?: () => void;
  onUpdate?: (update: SlashSubagentUpdateLike) => void;
}

function unsubscribe(fn: (() => void) | void): void {
  if (typeof fn === "function") fn();
}

export function requestSubagentRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: SubagentParamsLike,
  signal?: AbortSignal,
  callbacks: SubagentBridgeCallbacks = {},
): Promise<SlashSubagentResponseLike> {
  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (next: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(startTimeout);
      unsubscribe(unsubStarted);
      unsubscribe(unsubResponse);
      unsubscribe(unsubUpdate);
      signal?.removeEventListener("abort", onAbort);
      next();
    };

    const startTimeout = setTimeout(() => {
      finish(() => reject(new Error("pi-subagents did not start within 15s. Ensure the pi-subagents extension is loaded.")));
    }, 15_000);

    const onStarted = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      if ((data as { requestId?: unknown }).requestId !== requestId) return;
      clearTimeout(startTimeout);
      callbacks.onStarted?.();
    };

    const onResponse = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      const response = data as Partial<SlashSubagentResponseLike>;
      if (response.requestId !== requestId) return;
      finish(() => resolve(response as SlashSubagentResponseLike));
    };

    const onUpdate = (data: unknown) => {
      if (done || !data || typeof data !== "object") return;
      const update = data as SlashSubagentUpdateLike;
      if (update.requestId !== requestId) return;
      callbacks.onUpdate?.(update);
    };

    const onAbort = () => {
      try {
        pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
      } catch {
        // Best effort.
      }
      finish(() => reject(new Error("Task subagent run cancelled.")));
    };

    const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
    const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
    const unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, onUpdate);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params, ctx });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }

  });
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)));
}

function artifactOutput(result: SubagentSingleResultLike): string | undefined {
  const direct = result.artifactPaths?.outputPath;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const legacy = result.artifactPath;
  return typeof legacy === "string" && legacy.length > 0 ? legacy : undefined;
}

export function subagentRefFromResult(
  requestId: string,
  response: SlashSubagentResponseLike,
  result: SubagentSingleResultLike | undefined,
  fallbackAgent?: string,
): TaskSubagentRef {
  const details = response.result.details;
  return {
    requestId,
    runId: typeof details?.runId === "string" ? details.runId : undefined,
    asyncId: typeof details?.asyncId === "string" ? details.asyncId : undefined,
    asyncDir: typeof details?.asyncDir === "string" ? details.asyncDir : undefined,
    agent: result?.agent ?? fallbackAgent,
    sessionFiles: unique([result?.sessionFile]),
    savedOutputs: unique([result?.savedOutputPath]),
    artifactOutputs: unique([result ? artifactOutput(result) : undefined]),
  };
}

export function subagentRefFromResponse(
  requestId: string,
  response: SlashSubagentResponseLike,
  fallbackAgent?: string,
): TaskSubagentRef {
  const details = response.result.details;
  const results = details?.results ?? [];
  return {
    requestId,
    runId: typeof details?.runId === "string" ? details.runId : undefined,
    asyncId: typeof details?.asyncId === "string" ? details.asyncId : undefined,
    asyncDir: typeof details?.asyncDir === "string" ? details.asyncDir : undefined,
    agent: results.find((r) => typeof r.agent === "string")?.agent ?? fallbackAgent,
    sessionFiles: unique(results.map((r) => r.sessionFile)),
    savedOutputs: unique(results.map((r) => r.savedOutputPath)),
    artifactOutputs: unique(results.map((r) => artifactOutput(r))),
  };
}

export function subagentRefFromRun(run: TaskRunRecord): TaskSubagentRef {
  return {
    ...run.subagent,
    sessionFiles: [...run.subagent.sessionFiles],
    savedOutputs: [...run.subagent.savedOutputs],
    artifactOutputs: [...run.subagent.artifactOutputs],
  };
}

export function summarizeSubagentResponse(response: SlashSubagentResponseLike): string {
  const text = textBlock(response.result.content);
  if (text.trim()) return text.trim();
  const results = response.result.details?.results ?? [];
  const final = results.map((r) => r.finalOutput).filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (final.length > 0) return final.join("\n\n").trim();
  return response.errorText ?? "(no subagent output)";
}

/** Response-level failure: the subagent bridge itself reported an error.
 *  Typed loosely (optional isError/result) so it accepts both the full
 *  SlashSubagentResponseLike and the looser shape used by run-engine's
 *  per-child resultStatus mapper. */
export function responseIsError(response: { isError?: boolean; result?: { isError?: boolean } }): boolean {
  return Boolean(response.isError || response.result?.isError);
}

/** A single child result is failed if it is missing, exited non-zero, or errored.
 *  Shared by the single-run status mapper (subagentRunStatus) and the
 *  per-child mapper (run-engine resultStatus) so the failure vocabulary can't
 *  drift between the two paths. */
export function resultIsFailed(result: SubagentSingleResultLike | undefined): boolean {
  if (!result) return true;
  if (typeof result.exitCode === "number" && result.exitCode !== 0) return true;
  if (typeof result.error === "string" && result.error.length > 0) return true;
  return false;
}

export function subagentRunStatus(response: SlashSubagentResponseLike, requestedAsync: boolean): TaskRunStatus {
  if (responseIsError(response)) return "failed";
  const details = response.result.details;
  const results = details?.results ?? [];
  if (requestedAsync || typeof details?.asyncId === "string" || results.some((r) => r.detached)) return "detached";
  if (results.some((r) => resultIsFailed(r))) return "failed";
  return "completed";
}

export function usageFromResult(result: SubagentSingleResultLike | undefined): TaskRunRecord["usage"] {
  const usage = result?.usage;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    total: usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
    turns: usage.turns ?? 0,
    cost: usage.cost ?? 0,
  };
}

export function usageFromResponse(response: SlashSubagentResponseLike): TaskRunRecord["usage"] {
  const totals = { input: 0, output: 0, total: 0, turns: 0, cost: 0 };
  let seen = false;
  for (const result of response.result.details?.results ?? []) {
    const usage = usageFromResult(result);
    if (!usage) continue;
    seen = true;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.total += usage.total ?? 0;
    totals.turns += usage.turns ?? 0;
    totals.cost += usage.cost ?? 0;
  }
  return seen ? totals : undefined;
}

export function buildTaskPrompt(task: { id: string; title: string; prompt: string; blockedBy?: string[] }, opts: {
  dependencyOutputs?: string[];
  additionalContext?: string;
} = {}): string {
  const sections = [
    `You are executing task #${task.id}: ${task.title}`,
    task.prompt,
  ];
  if (opts.dependencyOutputs && opts.dependencyOutputs.length > 0) {
    sections.push(`## Completed dependency context\n\n${opts.dependencyOutputs.join("\n\n")}`);
  }
  if (opts.additionalContext?.trim()) sections.push(`## Additional context\n\n${opts.additionalContext.trim()}`);
  sections.push([
    "## Reporting contract",
    "Complete this task fully within the requested scope.",
    "Do not call pi-tasks tools from the child unless explicitly instructed.",
    "Report changed files, commands run with exit codes, validation results, and residual risks.",
  ].join("\n"));
  return sections.join("\n\n");
}
