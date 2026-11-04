import type {
  ISandboxMapper,
  SandboxApplication,
  SandboxContext,
} from "../shared/interfaces/ISandboxMapper";
import {
  CODEX_SANDBOX_MODES,
  EFFECTIVE_SANDBOX_KINDS,
  type CodexSandboxMode,
  type SandboxMode,
  type SandboxRequest,
} from "../../../types/DashboardConstants";
import type { SandboxCapabilityDescriptor } from "../shared/interfaces/ISandboxMapper";
import { SANDBOX_CAVEAT_CODE } from "../../../types/CompatibilityTypes";
import {
  harnessSettingSandbox,
  nativeSandboxCapabilities,
} from "../shared/SandboxCapabilities";

export const CODEX_SANDBOX_CAPABILITIES: SandboxCapabilityDescriptor =
  nativeSandboxCapabilities(
    "phase-0-results-2026-11-03-macos",
    [">=0.166.0"],
    "exact",
    SANDBOX_CAVEAT_CODE.NETWORK_FOLLOWS_HARNESS_POLICY
  );

/**
 * The `-s` value ctrlyoke passes Codex, shared by the sandbox flag and the
 * `--add-dir` filter. Approval (`-a`) follows the permission mode alone.
 * - `true` → `sandboxMode` (`workspace-write` or `read-only`)
 * - `false` → `danger-full-access`: the sandbox is off
 * - `null` → nothing: `config.toml` decides
 */
export function codexSandboxFlag(
  request: SandboxRequest | undefined,
  sandboxMode: SandboxMode
): CodexSandboxMode | undefined {
  if (request === true) return sandboxMode;
  if (request === false) return CODEX_SANDBOX_MODES.DANGER_FULL_ACCESS;
  return undefined;
}

export class CodexSandboxMapper implements ISandboxMapper {
  readonly capabilities = CODEX_SANDBOX_CAPABILITIES;

  async prepare(
    request: SandboxRequest | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication> {
    const flag = codexSandboxFlag(request, context.sandboxMode);
    if (!flag) return harnessSettingSandbox("Codex config.toml");
    return {
      cliArgs: ["-s", flag],
      diagnostics: [],
      effective: {
        kind:
          request === true
            ? EFFECTIVE_SANDBOX_KINDS.ON
            : EFFECTIVE_SANDBOX_KINDS.OFF,
        // No network claim: config.toml can open it under workspace-write.
        detail: `Codex ${flag}`,
      },
    };
  }
}
