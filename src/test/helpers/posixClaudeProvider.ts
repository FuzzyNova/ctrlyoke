import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { ClaudeSandboxMapper } from "../../core/harness/claude/ClaudeSandboxMapper";

/**
 * A Claude provider whose sandbox mapper behaves as on macOS, whatever host
 * runs the test. On Windows `ClaudeSandboxMapper` refuses `sandbox: true`
 * (Claude has no Bash sandbox there), so tests of the sandbox settings
 * themselves use this instead.
 */
export class PosixClaudeCliProvider extends ClaudeCliProvider {
  override readonly sandboxMapper = new ClaudeSandboxMapper("darwin");
}
