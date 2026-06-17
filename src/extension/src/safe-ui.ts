// ---------------------------------------------------------------------------
// Safe UI mutations during session replacement
//
// Pi swaps the ExtensionContext UI object on hot reload, /fork, and /tree
// navigation, so a setWidget/setStatus call may land on a stale UI that throws.
// Every pi-tasks UI write goes through these helpers so the "swallow stale-UI
// error" policy lives in one auditable place instead of being re-explained at
// every call site. Pure pass-through otherwise — behavior is identical to the
// inline try/catch it replaces.
// ---------------------------------------------------------------------------

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TASKS_WIDGET_NAME = "pi-tasks";

/** Set the pi-tasks status line, ignoring errors from a stale UI object. */
export function safeSetStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">, text: string | undefined): void {
  if (!ctx.hasUI) return;
  try { ctx.ui.setStatus(TASKS_WIDGET_NAME, text); } catch { /* UI may be stale during session replacement */ }
}

/** Remove the pi-tasks widget, ignoring errors from a stale UI object. */
export function safeClearWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  try { ctx.ui.setWidget(TASKS_WIDGET_NAME, undefined); } catch { /* UI may be stale during session replacement */ }
}
