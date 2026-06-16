# pi-tasks

Pi-native task tracking and subagent orchestration for [Pi](https://github.com/earendil-works/pi-coding-agent).

This package brings the useful parts of Claude Code's task experience to Pi:

- visible task list with completed/current/pending state
- tool-driven task creation and updates
- dependency-aware ready work
- one-command task execution through `pi-subagents`
- session-backed state that follows Pi branches/forks instead of a global JSON file
- exported event/type primitives that `pi-goals` can reuse later

## Install as a Pi package

```bash
pi install git:github.com/vsumner/pi-tasks
```

Make sure `pi-subagents` is also installed and loaded. `TaskRun`, `TaskStatus`, `TaskOutput`, `TaskResume`, `TaskRetry`, `TaskWait`, and `TaskStop` use the `pi-subagents` event bridge.

## Tools

| Tool | Purpose |
|---|---|
| `TaskCreate` | Create a structured task. |
| `TaskList` | Show all tasks or only ready work. |
| `TaskGet` | Get full task details and run metadata. |
| `TaskUpdate` | Update status/details/dependencies/metadata. |
| `TaskRun` | Run one or more ready tasks through `pi-subagents`; supports foreground parallel mode with `parallel: true`. |
| `TaskStatus` | Lightweight task/run status, with optional async status refresh. |
| `TaskOutput` | Show saved output or refresh async subagent status. |
| `TaskResume` | Resume a paused/interrupted `pi-subagents` run for a task. |
| `TaskRetry` | Retry a failed/cancelled task while preserving prior evidence. |
| `TaskWait` | Wait for an async task to finish with bounded polling. |
| `TaskStop` | Interrupt/cancel an in-flight subagent task. |

`TaskRun` defaults to a foreground `pi-subagents` run so the parent session can inspect output and update state immediately. Pass `async: true` for background runs. For multiple ready tasks, pass `parallel: true` plus optional `concurrency` to use `pi-subagents` foreground parallel mode. Async parallel is intentionally not enabled until `pi-subagents` async completion exposes stable per-child task IDs.

## Commands

```text
/tasks                         show the current task list
/tasks list                    show the current task list
/tasks ready                   show only ready pending tasks
/tasks active                  show in-progress tasks
/tasks failed                  show failed tasks
/tasks status [id]             show branch or task status
/tasks run <id...>             run tasks through pi-subagents
/tasks run ready --parallel    run ready tasks with foreground parallel subagents
/tasks output <id>             show task output/evidence
/tasks stop <id>               interrupt/cancel an in-flight task
/tasks resume <id> [message]   resume a pi-subagents run
/tasks retry <id>              retry a failed/cancelled task
/tasks wait <id>               wait for an async task to finish
/tasks snapshot                append a compact projection snapshot event
/tasks clear-completed         remove completed tasks from the current branch projection
/tasks clear-all               remove every task from the current branch projection
```

## State model

Task state is event-sourced through Pi session entries:

```text
pi-tasks:created
pi-tasks:updated
pi-tasks:status-updated
pi-tasks:run-started
pi-tasks:run-finished
pi-tasks:evidence-recorded
pi-tasks:deleted
pi-tasks:cleared
pi-tasks:snapshot
```

Event payloads include `version: 1`; legacy unversioned events still replay, while future-version events are ignored by this implementation. Snapshot events are optional compaction checkpoints and do not replace normal append-only task events.

That means task lists branch naturally with Pi sessions. A `/fork` or `/tree` navigation reconstructs the task projection from the selected branch; no `.pi/tasks.json` is written during normal operation.

## `pi-goals` integration surface

This extension intentionally has no dependency on `pi-goals`, but it exports stable primitives that goal runners can use:

- `TaskItem`, `TaskRunRecord`, `TaskEvidence`, and status unions from `task-state.ts`
- task lifecycle event constants from `events.ts`
- session projection via `getBranchTaskEvents()` / `projectTasksFromEvents()`
- tool-level packet launcher via `TaskCreate` + `TaskRun`

A future `pi-goals` packet can be represented as a task with:

```json
{
  "source": "pi-goals",
  "metadata": { "goalId": "...", "packetId": "..." },
  "agent": "worker",
  "acceptance": { "level": "verified", "verify": [] }
}
```

## Development

```bash
npm install
npm test
npm run typecheck
```
