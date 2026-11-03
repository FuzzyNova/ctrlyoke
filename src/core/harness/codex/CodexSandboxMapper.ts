import type {
  ISandboxMapper,
  SandboxApplication,
} from "../shared/interfaces/ISandboxMapper";
import { CODEX_SANDBOX_MODES } from "../../../types/DashboardConstants";
import type { SandboxCapabilityDescriptor } from "../shared/interfaces/ISandboxMapper";
import { SANDBOX_CAVEAT_CODE } from "../../../types/CompatibilityTypes";
import { resolveCodexContainment } from "./CodexToolPermissionMapper";
import {
  effectiveSandboxKind,
  nativeSandboxCapabilities,
} from "../shared/SandboxCapabilities";

export const CODEX_SANDBOX_CAPABILITIES: SandboxCapabilityDescriptor =
  nativeSandboxCapabilities(
    "phase-0-results-2026-11-03-macos",
    [">=0.166.0"],
    "exact",
    SANDBOX_CAVEAT_CODE.NETWORK_FOLLOWS_HARNESS_POLICY
  );

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
        // No network claim: config.toml can open it under workspace-write.
        detail: result.sandboxMode ? `Codex ${result.sandboxMode}` : undefined,
      },
    };
  }
}
