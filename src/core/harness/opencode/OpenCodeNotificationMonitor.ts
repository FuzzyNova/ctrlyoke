import {
  HOOK_CONFIG_TYPES,
  INotificationMonitor,
  HookConfig,
  NotificationMonitorBase,
} from "../shared/interfaces/INotificationMonitor";
import { CliNotificationMonitor } from "../shared/CliNotificationMonitor";
import type { HookEvent, UserHookConfig } from "../../../types/CtrlYokeTypes";
import {
  HOOK_CAVEAT_CODES,
  type CapabilityDeclaration,
  type HookCaveatCode,
} from "../../../types/CompatibilityTypes";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
} from "../../../types/DashboardConstants";

/**
 * OpenCode CLI Notification Monitor
 *
 * Completion detection strategy: OpenCode TypeScript plugin system.
 *
 * OpenCodeCliProvider registers the extension plugin through inline config. The plugin listens for
 * session.created, session.idle, and session.busy events, then writes:
 *
 *   {sessionId}-start.json → on session.created (for early session ID capture)
 *   {sessionId}-stop.json  → on session.idle (for completion detection)
 *
 * These match the standardized two-file format used by Claude and Copilot harnesses,
 * so all monitoring logic is inherited from NotificationMonitorBase unchanged.
 *
 * buildHookConfig() returns type: "none" because plugin registration is done
 * through OpenCode's inline config — not via CLI args.
 */
export class OpenCodeNotificationMonitor
  extends NotificationMonitorBase
  implements INotificationMonitor
{
  static readonly EVENT_MAP: Partial<Record<HookEvent, string>> = {
    stop: "session.status.idle",
    sessionStart: "session.created",
    preToolUse: "tool.execute.before",
    postToolUse: "tool.execute.after",
    userPromptSubmit: "session.status.busy",
    permissionRequest: "permission.asked",
    error: "session.error",
  };

  static readonly CAPABILITIES: Record<HookEvent, CapabilityDeclaration> = {
    stop: OpenCodeNotificationMonitor.verifiedHook(),
    sessionStart: OpenCodeNotificationMonitor.partialHook(
      HOOK_CAVEAT_CODES.MAIN_SESSION_START_UNRELIABLE
    ),
    preToolUse: OpenCodeNotificationMonitor.verifiedHook(),
    postToolUse: OpenCodeNotificationMonitor.verifiedHook(),
    userPromptSubmit: OpenCodeNotificationMonitor.verifiedHook(),
    permissionRequest: OpenCodeNotificationMonitor.partialHook(
      HOOK_CAVEAT_CODES.UNVERIFIED_DECISION_CONTRACT
    ),
    notification: OpenCodeNotificationMonitor.unsupportedHook(),
    error: OpenCodeNotificationMonitor.verifiedHook(),
  };

  private static verifiedHook(): CapabilityDeclaration {
    return {
      fidelity: CAPABILITY_FIDELITIES.EXACT,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
      verification: {
        kind: "manual",
        reference: "src/scripts/ctrlyoke-opencode-plugin.ts",
        basis: "cli-version",
        verifiedVersions: [">=1.1.48"],
      },
    };
  }

  private static partialHook(
    caveatCode: HookCaveatCode
  ): CapabilityDeclaration {
    return {
      fidelity: CAPABILITY_FIDELITIES.PARTIAL,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
      caveatCode,
      verification: {
        kind: "manual",
        reference: "src/scripts/ctrlyoke-opencode-plugin.ts",
        basis: "cli-version",
        verifiedVersions: [">=1.1.48"],
      },
    };
  }

  private static unsupportedHook(): CapabilityDeclaration {
    return {
      fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
      mechanism: CAPABILITY_MECHANISMS.NONE,
      caveatCode: HOOK_CAVEAT_CODES.NO_NATIVE_EVENT,
      verification: {
        kind: "manual",
        reference: "src/core/harness/opencode/OpenCodeNotificationMonitor.ts",
        basis: "cli-version",
        verifiedVersions: [">=1.18.10"],
      },
    };
  }

  /**
   * Build hook configuration.
   *
   * Returns type: "none" — OpenCode completion detection uses an inline plugin,
   * not CLI hook arguments.
   */
  buildHookConfig(
    _scriptPath: string,
    _notifyDir: string,
    _workspaceRoot: string,
    _userHooks?: UserHookConfig[],
    _ctrlyokeEvents?: HookEvent[]
  ): HookConfig {
    return { type: HOOK_CONFIG_TYPES.NONE };
  }

  /**
   * Get notification directory for OpenCode
   */
  getNotificationDirectory(workspaceRoot: string): string {
    return CliNotificationMonitor.getNotificationDirectory(
      workspaceRoot,
      "opencode"
    );
  }
}
