# pi-tasks — Architecture Review

Senior-engineer inheritance review. Findings are evidence-backed with `file:line`
refs and a measured performance probe. Baseline before review: `typecheck` clean,
149/149 tests pass.

---

## 1. Architecture Overview

A Pi extension that brings Claude-Code-style task tracking to Pi, with state
**event-sourced through Pi session entries** and execution **delegated to
`pi-subagents`** via an event bridge. ~4,146 LOC src + ~2,445 LOC tests across
15 modules.

### Layered design

```
┌─ PRESENTATION ──────────────────────────────────────────────┐
│ widget.ts        Claude-like status widget (TUI, 150ms tick) │
│ task-commands.ts /tasks slash command                         │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌─ TOOL / ORCHESTRATION ───────┴───────────────────────────────┐
│ task-tools.ts     12 LLM tools (thin registration)           │
│ task-run-engine   run lifecycle: single/parallel/async/      │
│                   resume/retry/wait/stop                     │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌─ STATE / BRIDGE ─────────────┴───────────────────────────────┐
│ task-store.ts     in-memory projection cache + mutation API   │
│                   (keyed by session id / cwd). emit() appends │
│                   an event AND re-projects it in-memory.      │
│ subagents.ts      pi-subagents event bridge (reqId correlation)│
└──────────────────────────────┬───────────────────────────────┘
                               │
┌─ PURE DOMAIN (no I/O, fully unit-tested) ────────────────────┐
│ task-state.ts     event-sourced reducer, types, readiness,    │
│                   claim evaluation                            │
│ events.ts         stable pi-tasks:* event-name constants      │
│ format.ts         display formatting + output-path affordances│
│ async-completion  parse subagent:async-complete payloads      │
│ task-schemas.ts   TypeBox tool param schemas + I/O shaping    │
│ task-projection   extract pi-tasks:* events from a Pi branch  │
└───────────────────────────────────────────────────────────────┘
```

### Data flow

```
LLM / /tasks command
   → tool/command handler
   → taskStore.<mutation>                       (task-store.ts)
       → emit(cwd, event)
           → appendEvent   → pi.appendEntry     (durable, session-scoped)
           → applyTaskEventToMap(in-mem)         (re-project this scope)
   → onTaskChanged(ctx, type, data)
       → widget.refresh(ctx)                     (display)
       → pi.events.emit(type, data)              (pi-goals consumers)

Durability:
  session_start / session_tree / before_agent_start
      → reconstruct() → getBranchTaskEvents → applyEvents  (full replay)
  session_before_compact
      → taskStore.snapshot()  (anchor full state at tail so it survives compaction)
```

### What is genuinely good

- **Pure, I/O-free domain core.** `task-state.ts` is a clean event-sourced
  reducer with strong unit coverage (149 tests). This is the strongest part of
  the codebase.
- **Event sourcing with versioning + compaction snapshot.** `version: 1` on
  payloads, future-version events ignored, snapshot anchors survive compaction.
  Solid durability story.
- **Prior O(1) optimizations already landed.** `indexById` readiness, widget
  version-cache, `completeRun` centralization, `safe-ui`. The author has been
  actively paying down debt.
- **Bridge isolation.** `subagents.ts` deliberately avoids importing
  pi-subagents internals; everything goes through the public event bridge.

---

## 2. Problem Areas

Ranked by severity. P0 = correctness/perf, P1 = maintainability/structure,
P2 = duplication, P3 = polish.

### P0-1 · Event projection deep-clones the entire map on every event (perf)

`applyTaskEventToMap` ([task-state.ts:456](src/extension/src/task-state.ts#L456))
opens with:

```ts
const tasks = new Map(Array.from(current.entries(), ([id, task]) => [id, clone(task)] as const));
```

Every single event deep-clones **every** task (JSON clone) before applying a
change that usually touches **one** task. `emit()` ([task-store.ts:202](src/extension/src/task-store.ts#L202))
calls it once per event.

Measured (`apply ONE updated-event`):

| tasks in map | cost / op |
|---|---|
| 50 | 36 µs |
| 200 | 143 µs |
| 1000 | **724 µs** |
| 4000 | **3.06 ms** |

Amplified by dependency fan-out: `reciprocalUpdates` makes `createTask` /
`updateTask` / `deleteTask` emit one event per affected dependency
([task-store.ts:315,336](src/extension/src/task-store.ts#L315)), so a delete
touching D dependencies = D full O(n) clones. Measured (k=20 updates, 1000-map):
**14.3 ms**. The defensive clone-on-apply exists for immutability safety, but
`readAll`/`readTask` *also* clone on read — the map is double-protected.

### P0-2 · `reconstruct()` replays the full event log every agent turn (perf)

`reconstruct` ([index.ts:134](src/extension/index.ts#L134)) runs on `session_start`,
`session_tree`, **and `before_agent_start`** ([index.ts:270,276,288](src/extension/index.ts#L288)).
`before_agent_start` fires before every agent turn. `projectTasksFromEvents`
re-applies the entire branch from an empty map.

Measured (full replay):

| event-log length | cost / replay |
|---|---|
| 50 | 0.86 ms |
| 200 | 13.8 ms |
| 1000 | **341 ms** |
| 4000 | **~6.0 s** |

The replay is roughly quadratic (each replayed event pays the P0-1 clone cost
against the growing accumulator). On a long, busy session this is paid in full
**on every turn**, blocking the agent start.

### P0-3 · `parseAsyncSummaryStatus` is an untested, brittle free-text parser (correctness)

`parseAsyncSummaryStatus` ([task-run-engine.ts:437](src/extension/src/task-run-engine.ts#L437))
regex-parses a human-readable `State: <word>` line out of pi-subagents status
*summary text* to decide whether an async task completed. It is **not exported
and has zero tests**. If pi-subagents changes its status-text wording, the
parser returns `{warning}` with no `status` → `refreshAsyncStatus` silently
no-ops → **the task stays `in_progress` forever** with no error surfaced. This
is the single most dangerous silent-failure path in the codebase. (The author
already flagged that three status vocabularies exist — [async-completion.ts:14](src/extension/src/async-completion.ts#L14)
— which is the smell that the abstraction is leaking across a string boundary.)

### P1-1 · Run engine is hardwired to the global `taskStore` singleton (coupling)

`widget.ts` and `task-commands.ts` receive `store` as an injected dependency
(`createTaskWidget(store, …)`, `registerTaskCommands(pi, store, …)`). The run
engine does **not** — it imports the singleton directly
([task-run-engine.ts:36](src/extension/src/task-run-engine.ts#L36)) and every
function reads the module global. Consequence: the engine is **not unit-testable
in isolation**; `task-tools.test.ts` (855 lines) is forced to stand up and mock
the process-wide singleton instead of passing a fixture store. Inconsistent with
the DI pattern used two files away.

### P1-2 · 12 of 14 run-engine helpers are private and untested

`canRun`, `resultStatus`, `resultSummary`, `parseAsyncSummaryStatus`,
`hasVerificationEvidence`, `taskRunRefId`, `makeRun`, `dependencyOutputs`, etc.
are `function` (not exported). Only `activeFormHint` / `completionFollowupHint`
escape. The fragile parsers and the readiness gate are exactly the logic that
most needs regression coverage.

### P1-3 · `index.ts` is a 357-line monolithic default export

One function owns: globalThis hot-reload state, event-appender wiring, the
async-completion handler (a complex scope-resolution + persistence-decision +
refresh-fan-out block, [index.ts:225-265](src/extension/index.ts#L225)), 8
lifecycle hooks, and the reminder-injection context hook. The async-completion
handler has no direct unit test — only the pure `async-completion.ts` helpers
are covered.

### P2-1 · Two subagent-params builders for one concept

`runOneTask` builds its params inline ([task-run-engine.ts:244-261](src/extension/src/task-run-engine.ts#L244))
while the parallel path uses `childParamsForTask` ([task-run-engine.ts:127](src/extension/src/task-run-engine.ts#L127)).
The `agent`/`task`/`cwd`/`model`/`output`/`outputMode`/`skill`/`acceptance`
fields are duplicated verbatim; the single path just adds
`context`/`async`/`clarify`/`includeProgress`/`artifacts`. A new passthrough
field must be added in both places or the two paths silently diverge.

### P2-2 · Cancelled-error classification duplicated ×3

`const cancelled = /cancelled|canceled|aborted/i.test(message)` appears at
[task-run-engine.ts:306, 417, 668](src/extension/src/task-run-engine.ts#L306).

### P2-3 · Run close-out catch block duplicated ×3

`catch → derive cancelled|failed status → completeRun + onChange(FINISHED)`
is copy-pasted across `runOneTask`, `runTasksInParallel`, `resumeTask`.

### P3-1 · Redundant type re-export chain

`task-store.ts` re-exports 14 types from `task-state.ts` ([task-store.ts:44](src/extension/src/task-store.ts#L44));
`index.ts` re-exports them *again*. Consumers import the same types from three
different modules inconsistently. The canonical source is `task-state.ts`.

### P3-2 · `currentHighWater` scans all keys per `nextId`

[task-store.ts](src/extension/src/task-store.ts) iterates every map key on each
id allocation. Low impact (createTask is rare) but trivially cacheable.

---

## 3. Refactor Strategy

Ordered by value/risk. Each item is independently shippable.

### Phase A — Safe duplication removal + testability (ship now, low risk)

Behavior-preserving, fully covered by the existing 149-test suite as a
regression net.

1. **Unify params builders (P2-1).** `runOneTask` calls `childParamsForTask`
   and merges the single-run-only keys. One source of truth.
2. **Extract `classifyRunError(msg)` (P2-2).** Single regex, used ×3.
3. **Extract `failRun(scope, id, error, runId, onChange, source)` (P2-3).**
   Collapses the three catch blocks.
4. **Export + unit-test the run-engine parsers (P0-3, P1-2).** `parseAsyncSummaryStatus`,
   `canRun`, `resultStatus`, `hasVerificationEvidence` become exported pure
   functions with targeted tests. This is the cheap insurance against the
   silent never-complete failure mode.

*Implemented in this review (Phase A). Proof: `npm run typecheck` + `npm test`.*

### Phase B — Structural decoupling (needs approach sign-off)

5. **Inject `store` into the run engine (P1-1).** Thread `store` through
   `runTasks`/`getTaskStatus`/… exactly like `widget`/`commands` already do.
   Mechanical (~14 call sites) and behavior-preserving, but a wide diff — worth
   its own packet. Unlocks isolated engine tests and shrinks `task-tools.test.ts`.
6. **Split `index.ts` (P1-3).** Extract the async-completion handler into its
   own module (`async-completion-handler.ts`) taking explicit dependencies, so
   the scope-resolution + persistence-decision logic becomes unit-testable.

### Phase C — Performance (needs invariant sign-off; load-bearing)

These touch immutability/replay invariants. Diagnose-and-prove now, implement
behind a focused packet.

7. **Structural sharing in the projection (P0-1).** Stop deep-cloning the whole
   map per event. Clone only the touched task; share the rest by reference. The
   event log is append-only and `readAll`/`readTask` already return defensive
   clones, so the per-event full clone is redundant. Requires an aliasing audit
   to prove no caller mutates the projected map in place.
8. **Incremental projection / replay caching (P0-2).** `reconstruct` should not
   replay from zero when the store already holds a valid projection whose
   high-water matches the branch tail. Options: (a) snapshot-replay — seed from
   the last `TASK_SNAPSHOT` and replay only post-snapshot events; (b) make
   `before_agent_start` reconstruct conditional on a dirty flag instead of
   unconditional. (a) also bounds worst-case replay cost after compaction.
9. **Drop the `task-store` → `task-state` type re-export layer (P3-1).** Have
   consumers import domain types from `task-state.ts` directly.

---

## 4. Improved Architecture (target state)

```
PURE DOMAIN (unchanged — already strong)
  task-state.ts · events.ts · format.ts · async-completion.ts
  task-schemas.ts · task-projection.ts

STATE
  task-store.ts        projection cache + mutation API (DI-friendly)
    · incremental projection seeded from last snapshot (Phase C-8)
    · structural sharing: clone touched task only, not whole map (Phase C-7)

BRIDGE
  subagents.ts         (unchanged)

ORCHESTRATION  ← dependency-injected `store`, pure helpers exported & tested
  task-run-engine.ts   run lifecycle (single/parallel/async/resume/retry/wait/stop)
  run-status.ts  (NEW) canonical run-status classification + error mapping
                       (collapses the 3 status vocabularies behind one adapter)

PRESENTATION
  task-tools.ts · task-commands.ts · widget.ts

ENTRYPOINT  ← thin; delegates to extracted handlers
  index.ts             lifecycle wiring only
  async-completion-handler.ts (NEW, Phase B-6) — unit-testable
```

The shape is mostly already correct. The work is: push the run engine to the
same DI standard as the presentation layer, extract the two monoliths, replace
the load-bearing clone/replay invariants with structural sharing + incremental
projection, and put regression tests in front of the fragile string parsers.
