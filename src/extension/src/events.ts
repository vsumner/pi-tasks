// ---------------------------------------------------------------------------
// Stable pi-tasks event names
// ---------------------------------------------------------------------------

export const TASK_EVENT_VERSION = 1;

export const TASK_CREATED_EVENT = "pi-tasks:created";
export const TASK_UPDATED_EVENT = "pi-tasks:updated";
export const TASK_STATUS_UPDATED_EVENT = "pi-tasks:status-updated";
export const TASK_RUN_STARTED_EVENT = "pi-tasks:run-started";
export const TASK_RUN_FINISHED_EVENT = "pi-tasks:run-finished";
export const TASK_EVIDENCE_RECORDED_EVENT = "pi-tasks:evidence-recorded";
export const TASK_DELETED_EVENT = "pi-tasks:deleted";
export const TASK_CLEARED_EVENT = "pi-tasks:cleared";
export const TASK_SNAPSHOT_EVENT = "pi-tasks:snapshot";

export const TASK_EVENT_TYPES = new Set([
  TASK_CREATED_EVENT,
  TASK_UPDATED_EVENT,
  TASK_STATUS_UPDATED_EVENT,
  TASK_RUN_STARTED_EVENT,
  TASK_RUN_FINISHED_EVENT,
  TASK_EVIDENCE_RECORDED_EVENT,
  TASK_DELETED_EVENT,
  TASK_CLEARED_EVENT,
  TASK_SNAPSHOT_EVENT,
]);
