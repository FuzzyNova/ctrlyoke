import type {
  ISandboxMapper,
  SandboxApplication,
  SandboxContext,
} from "../shared/interfaces/ISandboxMapper";
import {
  effectiveSandboxKind,
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
  HARNESS_IDS,
  SANDBOX_CAPABILITY_KEYS,
} from "../../../types/DashboardConstants";
import { hasCliFlag } from "../../../utils/CliArgParser";

export class ClaudeSandboxMapper implements ISandboxMapper {
  readonly capabilities = nativeSandboxCapabilities(
    "claude-file-tool-probe-2026-11-03-macos",
    [">=2.1.317"],
    "partial",
    SANDBOX_CAVEAT_CODE.FILE_TOOLS_BEST_EFFORT
  );

  async prepare(
    request: boolean | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication> {
    if (request !== true) {
      return {
        cliArgs: [],
        diagnostics: [],
        effective: { kind: effectiveSandboxKind(request) },
      };
    }
    return {
      cliArgs: [],
      settings: {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: false,
          filesystem: { allowWrite: [...context.writableRoots] },
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
        kind: effectiveSandboxKind(request),
        detail: "Claude Bash sandbox, network per Claude settings",
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
