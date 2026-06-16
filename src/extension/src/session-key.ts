import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function taskStoreKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return sessionId || ctx.cwd;
  } catch {
    return ctx.cwd;
  }
}
