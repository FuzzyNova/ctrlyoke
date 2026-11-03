import type {
  ISandboxMapper,
  SandboxApplication,
  SandboxContext,
} from "./interfaces/ISandboxMapper";

/** Small mapper for harnesses whose native sandbox is enabled by one flag. */
export class FlagSandboxMapper implements ISandboxMapper {
  constructor(readonly capabilities: ISandboxMapper["capabilities"]) {}

  async prepare(
    request: boolean | undefined,
    _context: SandboxContext
  ): Promise<SandboxApplication> {
    return {
      cliArgs: request === true ? ["--sandbox"] : [],
      diagnostics: [],
      effective: {
        kind: request === true ? "on" : request === false ? "off" : "harness",
      },
    };
  }
}
