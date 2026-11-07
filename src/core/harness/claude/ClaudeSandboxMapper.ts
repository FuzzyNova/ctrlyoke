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
  SANDBOX_CAVEAT_CODE,
  sandboxOverriddenDiagnostic,
  sandboxUnsupportedDiagnostic,
} from "../../../types/CompatibilityTypes";
import {
  EFFECTIVE_SANDBOX_KINDS,
  HARNESS_IDS,
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

  /** `platform` is injectable for tests; production uses the host's. */
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /**
   * - `true`: Bash sandbox on through the one merged `--settings` file.
   *   `workspace-write` allows writes to the workspace roots; `read-only`
   *   denies them (`denyWrite` outranks the default cwd write access).
   *   On Windows Claude has no Bash sandbox (2.1.319: "the Windows sandbox is
   *   not active on this session") and `failIfUnavailable` makes it exit, so
   *   `true` is treated as on a harness that can't sandbox: refused before
   *   launch when written, skipped with a warning when inherited.
   * - `false`: `sandbox.enabled: false`. `--settings` outranks user and
   *   project settings; a managed policy still wins.
   * - `null`: nothing.
   */
  async prepare(
    request: SandboxRequest | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication> {
    if (request === true && this.platform === "win32") {
      return {
        cliArgs: [],
        diagnostics: [
          sandboxUnsupportedDiagnostic({
            harnessId: HARNESS_IDS.CLAUDE_CLI,
            fromDefaults: context.requestFromDefaults,
            caveatCode: SANDBOX_CAVEAT_CODE.CLAUDE_WINDOWS_UNAVAILABLE,
          }),
        ],
        effective: { kind: EFFECTIVE_SANDBOX_KINDS.HARNESS },
      };
    }
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
          ? [
              sandboxOverriddenDiagnostic(
                HARNESS_IDS.CLAUDE_CLI,
                "sandbox: true cannot be applied on Claude because additionalArgs passes its own --settings, which would replace the sandbox settings. Remove --settings from additionalArgs or turn Sandbox off."
              ),
            ]
          : [],
      effective: {
        kind: EFFECTIVE_SANDBOX_KINDS.ON,
        detail: `Claude Bash ${context.sandboxMode}, network per Claude settings`,
      },
    };
  }
}
