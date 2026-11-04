import type {
  ISandboxMapper,
  SandboxApplication,
  SandboxContext,
} from "../shared/interfaces/ISandboxMapper";
import {
  harnessSettingSandbox,
  nativeSandboxCapabilities,
} from "../shared/SandboxCapabilities";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  SANDBOX_CAVEAT_CODE,
  type CompatibilityDiagnostic,
} from "../../../types/CompatibilityTypes";
import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  EFFECTIVE_SANDBOX_KINDS,
  HARNESS_IDS,
  SANDBOX_CAPABILITY_KEYS,
  SANDBOX_MODES,
  type SandboxRequest,
} from "../../../types/DashboardConstants";
import { hasCliFlag } from "../../../utils/CliArgParser";

export class ClaudeSandboxMapper implements ISandboxMapper {
  readonly capabilities = nativeSandboxCapabilities(
    "claude-file-tool-probe-2026-11-03-macos",
    [">=2.1.317"],
    "partial",
    SANDBOX_CAVEAT_CODE.FILE_TOOLS_BEST_EFFORT
  );

  /**
   * - `true`: Bash sandbox on through the one merged `--settings` file.
   *   `workspace-write` allows writes to the workspace roots; `read-only`
   *   denies them (`denyWrite` outranks the default cwd write access).
   * - `false`: `sandbox.enabled: false`. `--settings` outranks user and
   *   project settings; a managed policy still wins.
   * - `null`: nothing.
   */
  async prepare(
    request: SandboxRequest | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication> {
    if (request === false) {
      return {
        cliArgs: [],
        settings: { sandbox: { enabled: false } },
        diagnostics: [],
        effective: {
          kind: EFFECTIVE_SANDBOX_KINDS.OFF,
          detail: "Claude sandbox.enabled false",
        },
      };
    }
    if (request !== true) return harnessSettingSandbox("Claude settings");
    const readOnly = context.sandboxMode === SANDBOX_MODES.READ_ONLY;
    return {
      cliArgs: [],
      settings: {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: false,
          filesystem: readOnly
            ? { denyWrite: [...context.writableRoots] }
            : { allowWrite: [...context.writableRoots] },
        },
      },
      // Repeated --settings flags replace each other, so a user's own
      // --settings would silently drop the containment settings.
      diagnostics:
        context.additionalArgs &&
        hasCliFlag(context.additionalArgs, ["--settings"])
          ? [settingsOverriddenDiagnostic()]
          : [],
      effective: {
        kind: EFFECTIVE_SANDBOX_KINDS.ON,
        detail: `Claude Bash ${context.sandboxMode}, network per Claude settings`,
      },
    };
  }
}

function settingsOverriddenDiagnostic(): CompatibilityDiagnostic {
  return {
    code: COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_SETTINGS_OVERRIDDEN,
    severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
    harnessId: HARNESS_IDS.CLAUDE_CLI,
    capability: SANDBOX_CAPABILITY_KEYS.TERMINAL,
    state: {
      fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
      verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
    },
    message:
      "sandbox: true cannot be applied on Claude because additionalArgs passes its own --settings, which would replace the sandbox settings. Remove --settings from additionalArgs or turn Sandbox off.",
  };
}
