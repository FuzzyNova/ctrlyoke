import type {
  ISandboxMapper,
  SandboxApplication,
} from "../shared/interfaces/ISandboxMapper";
import { partialSandboxCapabilities } from "../shared/SandboxCapabilities";

export class ClaudeSandboxMapper implements ISandboxMapper {
  readonly capabilities = partialSandboxCapabilities(
    "phase-0-results-2026-11-03-macos",
    [">=2.1.317"]
  );

  async prepare(
    request: boolean | undefined,
    context: Parameters<ISandboxMapper["prepare"]>[1]
  ): Promise<SandboxApplication> {
    return {
      cliArgs: [],
      settings:
        request === true
          ? {
              sandbox: {
                enabled: true,
                failIfUnavailable: true,
                allowUnsandboxedCommands: false,
                autoAllowBashIfSandboxed: false,
                filesystem: { allowWrite: [...context.writableRoots] },
              },
            }
          : undefined,
      diagnostics: [],
      effective: {
        kind: request === true ? "on" : request === false ? "off" : "harness",
      },
    };
  }
}
