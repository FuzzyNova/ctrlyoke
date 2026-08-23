import {
  HookConfig,
  INotificationMonitor,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";
import type { CapabilityDeclaration } from "../../../types/CompatibilityTypes";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
} from "../../../types/DashboardConstants";

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

  static readonly EVENT_MAP: Partial<Record<HookEvent, AntigravityHookKey>> = {
    sessionStart: "PreInvocation",
    stop: "Stop",
    preToolUse: "PreToolUse",
    postToolUse: "PostToolUse",
  };

  static readonly CAPABILITIES: Record<HookEvent, CapabilityDeclaration> = {
    stop: AntigravityNotificationMonitor.verifiedHook(),
    sessionStart: AntigravityNotificationMonitor.verifiedHook(),
    preToolUse: AntigravityNotificationMonitor.verifiedHook(),
    postToolUse: AntigravityNotificationMonitor.verifiedHook(),
    userPromptSubmit: AntigravityNotificationMonitor.unsupportedHook(),
    permissionRequest: AntigravityNotificationMonitor.unsupportedHook(),
    notification: AntigravityNotificationMonitor.unsupportedHook(),
    error: AntigravityNotificationMonitor.unsupportedHook(),
  };

  private static verifiedHook(): CapabilityDeclaration {
    return {
      fidelity: CAPABILITY_FIDELITIES.EXACT,
      mechanism: CAPABILITY_MECHANISMS.WORKSPACE_CONFIG,
      verification: {
        kind: "manual",
        reference:
          "src/core/harness/antigravity/AntigravityNotificationMonitor.ts",
        basis: "cli-version",
        verifiedVersions: [">=1.1.12"],
      },
    };
  }

  private static unsupportedHook(): CapabilityDeclaration {
    return {
      fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
      mechanism: CAPABILITY_MECHANISMS.NONE,
      verification: {
        kind: "manual",
        reference:
          "src/core/harness/antigravity/AntigravityNotificationMonitor.ts",
        basis: "cli-version",
        verifiedVersions: [">=1.1.12"],
      },
    };
  }

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
    const selectedEvents = new Set<HookEvent>(ctrlyokeEvents ?? ["stop"]);

    const group: Record<AntigravityHookKey, unknown[] | null> = {
      PreToolUse: null,
      PostToolUse: null,
      PreInvocation: null,
      PostInvocation: null,
      Stop: null,
    };

    const pushHandler = (
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

    // agy does NOT include the event name in the hook's stdin payload, so pass
    // the native event name as argv[3]. Supported ctrlyoke logical events map
    // 1:1 to a single native event for agy; unsupported ones are skipped.
    const addHandler = (eventKey: AntigravityHookKey) => {
      pushHandler(eventKey, `${baseCommand} ${eventKey}`);
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

    for (const hook of userHooks ?? []) {
      const nativeEvent = AntigravityNotificationMonitor.EVENT_MAP[hook.event];
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
