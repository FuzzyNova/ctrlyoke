import {
  HookConfig,
  INotificationMonitor,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";

type AntigravityHookKey =
  | "PreToolUse"
  | "PostToolUse"
  | "PreInvocation"
  | "PostInvocation"
  | "Stop";

export class AntigravityNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  readonly supportsSessionStart = true;

  private static readonly USER_EVENT_MAP: Partial<
    Record<HookEvent, AntigravityHookKey>
  > = {
      sessionStart: "PreInvocation",
      stop: "Stop",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      permissionRequest: "PreToolUse",
    };

  protected override getStartHookEvents(): string[] {
    return ["PreInvocation"];
  }

  buildHookConfig(
    scriptPath: string,
    notifyDir: string,
    _workspaceRoot: string,
    userHooks?: UserHookConfig[],
    ctrlyokeEvents?: HookEvent[]
  ): HookConfig {
    const command = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      notifyDir
    );
    const encodedDecisionHook = this.encodePermissionRequestHook(userHooks);
    const selectedEvents = new Set<HookEvent>(ctrlyokeEvents ?? ["stop"]);

    const group: Record<AntigravityHookKey, unknown[] | null> = {
      PreToolUse: null,
      PostToolUse: null,
      PreInvocation: null,
      PostInvocation: null,
      Stop: null,
    };

    const addHandler = (
      eventKey: AntigravityHookKey,
      handlerCommand: string
    ) => {
      group[eventKey] ??= [];
      group[eventKey]!.push({
        type: "command",
        command: handlerCommand,
        timeout: 0,
      });
    };

    if (selectedEvents.has("sessionStart")) {
      addHandler("PreInvocation", command);
    }
    if (selectedEvents.has("stop")) {
      addHandler("PostInvocation", command);
      addHandler("Stop", command);
    }
    if (selectedEvents.has("preToolUse")) {
      addHandler("PreToolUse", command);
    }
    if (selectedEvents.has("postToolUse")) {
      addHandler("PostToolUse", command);
    }
    if (selectedEvents.has("permissionRequest")) {
      addHandler(
        "PreToolUse",
        encodedDecisionHook ? `${command} "${encodedDecisionHook}"` : command
      );
    }

    for (const hook of userHooks ?? []) {
      if (
        hook.event === "permissionRequest" &&
        selectedEvents.has("permissionRequest")
      ) {
        continue;
      }

      const nativeEvent =
        AntigravityNotificationMonitor.USER_EVENT_MAP[hook.event];
      if (!nativeEvent) {
        continue;
      }
      addHandler(nativeEvent, hook.command);
    }

    return {
      type: "json",
      config: { ctrlyoke: group },
    };
  }

  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "antigravity"
    );
  }
}
