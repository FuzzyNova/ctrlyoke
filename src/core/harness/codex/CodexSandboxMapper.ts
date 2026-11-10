import type {
  ISandboxMapper,
  SandboxApplication,
  SandboxContext,
} from "../shared/interfaces/ISandboxMapper";
import {
  CODEX_SANDBOX_MODES,
  EFFECTIVE_SANDBOX_KINDS,
  HARNESS_IDS,
  type CodexSandboxMode,
  type SandboxMode,
  type SandboxRequest,
} from "../../../types/DashboardConstants";
import type { SandboxCapabilityDescriptor } from "../shared/interfaces/ISandboxMapper";
import {
  SANDBOX_CAVEAT_CODE,
  sandboxOverriddenDiagnostic,
} from "../../../types/CompatibilityTypes";
import { getCliFlagValues, hasCliFlag } from "../../../utils/CliArgParser";
import {
  harnessSettingSandbox,
  nativeSandboxCapabilities,
} from "../shared/SandboxCapabilities";

const CODEX_SANDBOX_CAPABILITIES: SandboxCapabilityDescriptor =
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

/** `--yolo` is an undocumented alias Codex 0.166.0 still accepts. */
const CODEX_BYPASS_FLAGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
] as const;
const CODEX_SANDBOX_FLAGS = ["-s", "--sandbox"] as const;
const CODEX_CONFIG_FLAGS = ["-c", "--config"] as const;
/** `-c` keys that set containment: `sandbox_mode`, `sandbox_workspace_write.*`, `sandbox_permissions`. */
const CODEX_SANDBOX_CONFIG_KEY =
  /^sandbox_(mode|workspace_write|permissions)(\.|$)/;

/**
 * The first `additionalArgs` form that would contradict the `-s` ctrlyoke
 * emits for `sandbox: true`, as Codex 0.166.0 behaves:
 * - the bypass flag wins over `-s` and runs with `danger-full-access`;
 * - a second `-s` is rejected outright ("cannot be used multiple times");
 * - `-c sandbox_workspace_write.*` adds writable roots or opens the network.
 * `-c sandbox_mode=…` loses to `-s`, but is refused too as a contradiction.
 */
function findSandboxOverride(additionalArgs: string): string | undefined {
  const bypass = CODEX_BYPASS_FLAGS.find((flag) =>
    hasCliFlag(additionalArgs, [flag])
  );
  if (bypass) return bypass;
  const sandbox = getCliFlagValues(additionalArgs, CODEX_SANDBOX_FLAGS)[0];
  if (sandbox !== undefined) return `-s ${sandbox}`;
  const config = getCliFlagValues(additionalArgs, CODEX_CONFIG_FLAGS).find(
    (value) => CODEX_SANDBOX_CONFIG_KEY.test(value.split("=")[0].trim())
  );
  return config ? `-c ${config}` : undefined;
}

export class CodexSandboxMapper implements ISandboxMapper {
  readonly capabilities = CODEX_SANDBOX_CAPABILITIES;

  async prepare(
    request: SandboxRequest | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication> {
    const flag = codexSandboxFlag(request, context.sandboxMode);
    if (!flag) return harnessSettingSandbox("Codex config.toml");
    const override =
      request === true && context.additionalArgs
        ? findSandboxOverride(context.additionalArgs)
        : undefined;
    return {
      cliArgs: ["-s", flag],
      diagnostics: override
        ? [
            sandboxOverriddenDiagnostic(
              HARNESS_IDS.CODEX_CLI,
              `sandbox: true cannot be applied on Codex because additionalArgs passes ${override}, which would replace or widen the sandbox ctrlyoke sets. Remove it from additionalArgs or turn Sandbox off.`
            ),
          ]
        : [],
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
