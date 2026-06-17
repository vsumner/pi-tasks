# pi-tasks — Agent & Contributor Guide

Pi-native task tracking and subagent orchestration. Inspired by Claude Code's task UX, but canonical state is Pi session-backed and execution is delegated through `pi-subagents`.

## Commands

```bash
npm test
npm run typecheck
```

Run both before review.

## Architecture invariants

- Canonical task state lives in Pi session entries appended via `pi.appendEntry("pi-tasks:*", ...)`.
- `taskStore` is an in-memory projection over those events. Never write normal task state to files.
- Every mutation must go through `taskStore.*`; do not mutate projected task objects directly.
- `pi-subagents` is the execution substrate. Do not reimplement child-process or agent orchestration here.
- `pi-goals` integration should use exported event names/types or the task tools; do not make this package depend on `pi-goals`.

## Module map

| Path | Role |
|---|---|
| `src/extension/index.ts` | Extension entrypoint, lifecycle hooks, hot-reload guard. |
| `src/extension/src/events.ts` | Stable `pi-tasks:*` event-name constants. |
| `src/extension/src/format.ts` | Shared task/status/output formatting helpers. |
| `src/extension/src/session-key.ts` | Session-scoped task-store key helper. |
| `src/extension/src/task-state.ts` | Public task types and pure reducer/projection helpers. |
| `src/extension/src/task-store.ts` | Session-backed projection cache and mutation API. |
| `src/extension/src/task-tools.ts` | LLM tools: `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskClaim`, `TaskRun`, `TaskStatus`, `TaskOutput`, `TaskResume`, `TaskRetry`, `TaskWait`, `TaskStop`. |
| `src/extension/src/subagents.ts` | Event bridge to `pi-subagents`; no orchestration logic elsewhere. |
| `src/extension/src/widget.ts` | Claude-like task status widget. |
| `src/extension/src/task-commands.ts` | `/tasks` command UI. |
| `src/extension/src/task-projection.ts` | Extracts `pi-tasks:*` events from the current Pi branch. |

## Status model

Task status values: `pending`, `in_progress`, `blocked`, `completed`, `failed`, `cancelled`.

Subagent run status values: `queued`, `running`, `detached`, `completed`, `failed`, `cancelled`.

`TaskRun` starts a run through `pi-subagents`; foreground runs finish the task in the same tool call, while async runs leave the task `in_progress` with `subagent.asyncId`/`runId` metadata for `TaskStatus`/`TaskOutput`/`TaskWait`/`TaskStop`. Foreground multi-task runs may use `parallel: true`; async parallel remains intentionally unsupported until per-child async completion IDs are stable.
