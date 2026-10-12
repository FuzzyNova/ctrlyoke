import type { UserHookConfig } from "../../../types/CtrlYokeTypes";
import { timeoutSecToNative } from "./interfaces/INotificationMonitor";

const CODEX_EVENTS_WITH_MATCHERS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "SessionStart",
  "PreCompact",
  "PostCompact",
]);

export function normalizeCodexHookMatcher(
  eventName: string,
  matcher: string | undefined
): string | undefined {
  return CODEX_EVENTS_WITH_MATCHERS.has(eventName) ? matcher : undefined;
}

export function createCodexCommandHookGroup(
  eventName: string,
  command: string,
  userHook?: UserHookConfig
): Record<string, unknown> {
  const matcher = normalizeCodexHookMatcher(eventName, "");
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command,
        ...(timeoutSecToNative(userHook?.timeoutSec) !== undefined
          ? { timeout: timeoutSecToNative(userHook?.timeoutSec) }
          : {}),
      },
    ],
  };
}
