---
name: pi-tasks
description: Use this skill when working with the pi-tasks extension, task tracking tools, task/subagent orchestration, or future pi-goals task packet integration.
---

# pi-tasks

Use `pi-tasks` for bounded task lists that may be executed by `pi-subagents`.

Core rules:
- Create tasks only for non-trivial multi-step work or explicit task-list requests.
- Mark a task `in_progress` before executing it and `completed` only when evidence proves it is done.
- Use dependencies (`addBlockedBy`, `addBlocks`) instead of relying on prose order.
- Use `TaskClaim` when ownership must be claimed safely instead of blindly overwriting `owner`.
- Use `TaskRun` for subagent execution; do not spawn separate subagents for the same task.
- Use `TaskRun` with `parallel: true` only for foreground multi-task runs; async parallel is intentionally unsupported until per-child async IDs are stable.
- Use `TaskStatus` for lightweight status checks, `TaskOutput` for full output, `TaskWait` for bounded async polling, `TaskResume` for paused runs, and `TaskRetry` for failed/cancelled tasks.
- Preserve `source` and `metadata` for cross-extension integration, especially `pi-goals` packets.

Typical loop:
1. `TaskCreate` one task per bounded deliverable.
2. `TaskUpdate` dependencies if order matters.
3. `TaskList` with `ready_only: true`.
4. `TaskClaim` when an owner needs safe claim-or-report semantics.
5. `TaskRun` ready tasks through `pi-subagents`.
6. `TaskStatus`/`TaskOutput`/`TaskWait` to inspect or refresh run state.
7. `TaskResume` or `TaskRetry` only when the run lifecycle calls for it.
8. `TaskUpdate` or follow-up tasks for unresolved work.
