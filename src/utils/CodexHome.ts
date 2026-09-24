import * as os from "os";
import * as path from "path";

/**
 * Returns Codex's home directory: `CODEX_HOME` when set, else `~/.codex`.
 * Codex keeps its config, auth, and session logs there, so every lookup of
 * those files resolves through this one function.
 *
 * Deliberately dependency-free (no `vscode`, no config service) so the
 * real-harness test helpers, which run under plain Mocha, can import it.
 */
export function getCodexHomeDir(): string {
  const configuredHome = process.env.CODEX_HOME?.trim();
  return configuredHome || path.join(os.homedir(), ".codex");
}
