import { Command } from "commander";

export interface StatusOptions {
  cwd?: string;
  workflow?: string;
  run?: string;
  json?: boolean;
}

export interface StatusCommandHandlers {
  status(options: StatusOptions): Promise<void>;
}

export function registerStatusCommand(
  program: Command,
  handlers: StatusCommandHandlers
): void {
  program
    .command("status")
    .description("List executing workflows and runner liveness")
    .option("--workflow <key>", "Workflow lineage key or exact name")
    .option("--run <ref>", "Restrict to a specific run (requires --workflow)")
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--json", "Output as JSON")
    .action(async (options: StatusOptions) => handlers.status(options));
}
