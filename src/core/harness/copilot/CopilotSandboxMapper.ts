import type {
  ISandboxMapper,
  SandboxApplication,
} from "../shared/interfaces/ISandboxMapper";
import { FlagSandboxMapper } from "../shared/FlagSandboxMapper";
import { partialSandboxCapabilities } from "../shared/SandboxCapabilities";

export class CopilotSandboxMapper implements ISandboxMapper {
  private readonly mapper = new FlagSandboxMapper(
    partialSandboxCapabilities("phase-0-results-2026-11-03-macos")
  );
  get capabilities() {
    return this.mapper.capabilities;
  }
  prepare(
    request: boolean | undefined,
    context: Parameters<ISandboxMapper["prepare"]>[1]
  ): Promise<SandboxApplication> {
    return this.mapper.prepare(request, context);
  }
}
