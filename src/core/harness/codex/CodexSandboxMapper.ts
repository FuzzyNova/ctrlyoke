import type {
  ISandboxMapper,
  SandboxApplication,
} from "../shared/interfaces/ISandboxMapper";
import { CODEX_SANDBOX_MODES } from "../../../types/DashboardConstants";
import type { SandboxCapabilityDescriptor } from "../shared/interfaces/ISandboxMapper";
import { resolveCodexContainment } from "./CodexToolPermissionMapper";
import { effectiveSandboxKind } from "../shared/SandboxCapabilities";

const CODEX_SANDBOX_VERIFICATION = {
  kind: "manual",
  reference:
    "dev/backlog/HARNESS_SANDBOX_PLAN.md#phase-0-results-2026-11-03-macos",
  basis: "cli-version",
  verifiedVersions: [">=0.166.0"],
} as const;

export const CODEX_SANDBOX_CAPABILITIES: SandboxCapabilityDescriptor = {
  terminal: {
    fidelity: "partial",
    mechanism: "native",
    verification: CODEX_SANDBOX_VERIFICATION,
  },
};

export class CodexSandboxMapper implements ISandboxMapper {
  readonly capabilities = CODEX_SANDBOX_CAPABILITIES;

  async prepare(
    request: boolean | undefined,
    context: Parameters<ISandboxMapper["prepare"]>[1]
  ): Promise<SandboxApplication> {
    const result = resolveCodexContainment(
      context.toolPermissions,
      request,
      context.codexSandboxMode ?? CODEX_SANDBOX_MODES.WORKSPACE_WRITE
    );
    return {
      cliArgs:
        request === undefined || result.bypass || !result.sandboxMode
          ? []
          : ["-s", result.sandboxMode],
      diagnostics: result.diagnostic ? [result.diagnostic] : [],
      effective: {
        kind: effectiveSandboxKind(request),
        detail: result.sandboxMode
          ? `Codex ${result.sandboxMode}, network off`
          : undefined,
      },
    };
  }
}
