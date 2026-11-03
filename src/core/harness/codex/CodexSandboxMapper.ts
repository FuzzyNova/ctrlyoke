import type {
  ISandboxMapper,
  SandboxApplication,
} from "../shared/interfaces/ISandboxMapper";
import { CODEX_SANDBOX_MODES } from "../../../types/DashboardConstants";
import type { SandboxCapabilityDescriptor } from "../shared/interfaces/ISandboxMapper";
import { resolveCodexContainment } from "./CodexToolPermissionMapper";
import {
  effectiveSandboxKind,
  partialSandboxCapabilities,
} from "../shared/SandboxCapabilities";

export const CODEX_SANDBOX_CAPABILITIES: SandboxCapabilityDescriptor =
  partialSandboxCapabilities("phase-0-results-2026-11-03-macos", [">=0.166.0"]);

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
        detail: !result.sandboxMode
          ? undefined
          : result.sandboxMode === CODEX_SANDBOX_MODES.DANGER_FULL_ACCESS
            ? `Codex ${result.sandboxMode}`
            : `Codex ${result.sandboxMode}, network off`,
      },
    };
  }
}
