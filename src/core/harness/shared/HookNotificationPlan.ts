import {
  HARNESS_IDS,
  HOOK_EVENT_NAMES,
  HOOK_EVENT_ORDER,
  type HarnessId,
  type HookEvent,
} from "../../../types/DashboardConstants";
import type { CtrlYokeNotificationSettings } from "../../../types/CtrlYokeSettings";

export interface AwaitingInputSource {
  event: HookEvent;
  notificationTypes?: string[];
}

/** Native hook source selected for the semantic awaitingInput notification. */
export const AWAITING_INPUT_SOURCES: Record<
  HarnessId,
  AwaitingInputSource | null
> = {
  [HARNESS_IDS.COPILOT_CLI]: {
    event: HOOK_EVENT_NAMES.NOTIFICATION,
    notificationTypes: ["permission_prompt", "elicitation_dialog"],
  },
  [HARNESS_IDS.CLAUDE_CLI]: {
    event: HOOK_EVENT_NAMES.NOTIFICATION,
    notificationTypes: ["permission_prompt", "elicitation_dialog"],
  },
  [HARNESS_IDS.QWEN_CLI]: {
    event: HOOK_EVENT_NAMES.NOTIFICATION,
    notificationTypes: ["permission_prompt"],
  },
  [HARNESS_IDS.CODEX_CLI]: { event: HOOK_EVENT_NAMES.PERMISSION_REQUEST },
  [HARNESS_IDS.OPENCODE_CLI]: { event: HOOK_EVENT_NAMES.PERMISSION_REQUEST },
  [HARNESS_IDS.ANTIGRAVITY_CLI]: null,
};

export interface HookNotificationPlan {
  installEvents: HookEvent[];
  emitRawEvents: HookEvent[];
  awaitingInput?: AwaitingInputSource;
}

/**
 * Serialize a source for CTRLYOKE_NOTIFY_AWAITING_INPUT. The hook scripts
 * parse `event:type1,type2` for notification filters and a bare `event` when
 * no notification-type filter is needed.
 */
export function serializeAwaitingInputRule(
  source: AwaitingInputSource
): string {
  return source.notificationTypes?.length
    ? `${source.event}:${source.notificationTypes.join(",")}`
    : source.event;
}

export function resolveHookNotificationPlan(
  harnessId: HarnessId,
  notificationSettings: Pick<CtrlYokeNotificationSettings, "events">,
  options: { hooksDisabled: boolean } = { hooksDisabled: false }
): HookNotificationPlan {
  const emitRawEvents = HOOK_EVENT_ORDER.filter(
    (event) => notificationSettings.events.hookEvents[event]
  );
  const source =
    !options.hooksDisabled && notificationSettings.events.awaitingInput
      ? (AWAITING_INPUT_SOURCES[harnessId] ?? undefined)
      : undefined;
  const installEventSet = new Set(emitRawEvents);
  if (!options.hooksDisabled && source) {
    installEventSet.add(source.event);
  }

  return {
    installEvents: options.hooksDisabled
      ? []
      : HOOK_EVENT_ORDER.filter((event) => installEventSet.has(event)),
    emitRawEvents,
    ...(source ? { awaitingInput: source } : {}),
  };
}
