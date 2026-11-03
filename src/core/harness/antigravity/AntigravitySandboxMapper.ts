import * as os from "os";
import type {
  ISandboxMapper,
  SandboxApplication,
} from "../shared/interfaces/ISandboxMapper";
import { COMPATIBILITY_DIAGNOSTIC_SEVERITIES } from "../../../types/DashboardConstants";
import { HARNESS_IDS } from "../../../types/DashboardConstants";
import { partialSandboxCapabilities } from "../shared/SandboxCapabilities";

export class AntigravitySandboxMapper implements ISandboxMapper {
  readonly capabilities = partialSandboxCapabilities(
    "phase-0-results-2026-11-03-macos"
  );
  async prepare(
    request: boolean | undefined,
    context: Parameters<ISandboxMapper["prepare"]>[1]
  ): Promise<SandboxApplication> {
    const diagnostics: SandboxApplication["diagnostics"] = [];
    if (request === true && process.platform === "win32") {
      const build = Number(os.release().split(".").pop());
      if (!Number.isFinite(build) || build < 26100)
        diagnostics.push({
          severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
          code: "compatibility.sandbox.antigravity.windowsBuild",
          harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
          capability: "sandbox.terminal",
          state: {
            fidelity: "partial",
            mechanism: "native",
            verification: "verified",
          },
          message:
            "Antigravity terminal sandboxing requires Windows build 26100 or newer.",
        });
    }
    if (
      request === true &&
      context.additionalArgs &&
      /(?:^|\s)--sandbox(?:\s|$)/.test(context.additionalArgs)
    )
      diagnostics.push({
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        code: "compatibility.sandbox.duplicateFlag",
        harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
        capability: "sandbox.terminal",
        state: {
          fidelity: "partial",
          mechanism: "native",
          verification: "verified",
        },
        message: "additionalArgs already contains --sandbox.",
      });
    return {
      cliArgs: request === true ? ["--sandbox"] : [],
      diagnostics,
      effective: {
        kind: request === true ? "on" : request === false ? "off" : "harness",
      },
    };
  }
}
