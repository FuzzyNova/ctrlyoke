/**
 * A harness CLI's vendor-recommended install command for each host OS family.
 * Keep these in step with each vendor's install page; the harness docs pages
 * under `docs/harnesses/` show the same commands.
 */
export interface HarnessInstallCommands {
  /** macOS and Linux (bash). */
  posix: string;
  /** Windows, as typed into PowerShell (VS Code's default Windows terminal). */
  windows: string;
}

/**
 * The bare install command for the OS the harness will run on, ready to paste
 * into a terminal. The extension host, not the dashboard viewer, spawns the
 * CLI, so resolve against this process. Prose around it comes from
 * `formatHarnessInstallGuidance`.
 */
export function installCommandFor(
  commands: HarnessInstallCommands,
  platform: NodeJS.Platform = process.platform
): string {
  return platform === "win32" ? commands.windows : commands.posix;
}
