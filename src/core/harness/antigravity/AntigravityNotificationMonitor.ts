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
    // agy executes hook commands with naive whitespace splitting and keeps
    // literal quote characters (no shell quote processing), running them with
    // cwd = ~/.gemini/config. A quoted path therefore reaches node with the
    // quotes intact and is resolved relative to the config dir → "Cannot find
    // module". Emit the command UNQUOTED (forward-slash absolute paths).
    // NOTE: this means paths containing spaces are unsupported by agy hooks.
    const baseCommand = CliNotificationMonitor.buildNodeCommand(
      scriptPath,
      notifyDir,
      false
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

    const pushHandler = (eventKey: AntigravityHookKey, handlerCommand: string) => {
      group[eventKey] ??= [];
      group[eventKey]!.push({
        type: "command",
        command: handlerCommand,
        timeout: 0,
      });
    };

    // agy does NOT include the event name in the hook's stdin payload, so pass
    // the native event name as an argv to our script (argv[3]). Each event has
    // its own command string in hooks.json, so this uniquely identifies it.
    const addHandler = (eventKey: AntigravityHookKey, extraArg?: string) => {
      const parts = [baseCommand, eventKey];
      if (extraArg) {
        parts.push(extraArg);
      }
      pushHandler(eventKey, parts.join(" "));
    };

    if (selectedEvents.has("sessionStart")) {
      addHandler("PreInvocation");
    }
    if (selectedEvents.has("stop")) {
      // Use Stop (fires once when the agent goes idle after a turn), NOT
      // PostInvocation — PostInvocation fires per LLM invocation, so it fires
      // multiple times per turn whenever tool calls are involved.
      addHandler("Stop");
    }
    if (selectedEvents.has("preToolUse")) {
      addHandler("PreToolUse");
    }
    if (selectedEvents.has("postToolUse")) {
      addHandler("PostToolUse");
    }
    if (selectedEvents.has("permissionRequest")) {
      // encodedDecisionHook is base64 (no spaces), safe to pass unquoted.
      addHandler("PreToolUse", encodedDecisionHook || undefined);
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
      // User-supplied commands are run verbatim (not our script), so they get
      // no injected event-name arg.
      pushHandler(nativeEvent, hook.command);
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
