import { Command } from "commander";

export interface HistoryPruneOptions {
  yes?: boolean;
}

export interface HistoryRelinkOptions {
  yes?: boolean;
}

export interface HistoryListOptions {
  cwd?: string;
  all?: boolean;
  json?: boolean;
}

export interface HistoryRunsOptions {
  cwd?: string;
  workflow: string;
  json?: boolean;
}

export interface HistoryShowOptions {
  cwd?: string;
  workflow: string;
  run: string;
  step?: string;
  json?: boolean;
  color?: boolean;
}

export interface HistoryCommandHandlers {
  prune(options: HistoryPruneOptions): Promise<void>;
  relink(
    oldPath: string,
    newPath: string,
    options: HistoryRelinkOptions
  ): Promise<void>;
  list(options: HistoryListOptions): Promise<void>;
  runs(options: HistoryRunsOptions): Promise<void>;
  show(options: HistoryShowOptions): Promise<void>;
}

/** Registers lifecycle commands that operate on the user project registry. */
export function registerHistoryCommands(
  program: Command,
  handlers: HistoryCommandHandlers
): void {
  const history = program
    .command("history")
    .description("Inspect and maintain persisted run history");

  history
    .command("prune")
    .description("List or delete project state whose repository is gone")
    .option("-y, --yes", "Delete orphaned project state")
    .action(async (options: HistoryPruneOptions) => handlers.prune(options));

  history
    .command("relink <oldPath> <newPath>")
    .description("Move project history after a repository path changes")
    .option("-y, --yes", "Apply the relink")
    .action(
      async (oldPath: string, newPath: string, options: HistoryRelinkOptions) =>
        handlers.relink(oldPath, newPath, options)
    );

  history
    .command("list")
    .description("List workflow lineages in this workspace")
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--all", "Include system-generated lineages")
    .option("--json", "Output as JSON")
    .action(async (options: HistoryListOptions) => handlers.list(options));

  history
    .command("runs")
    .description("List runs within a workflow lineage")
    .requiredOption("--workflow <key>", "Workflow lineage key")
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--json", "Output as JSON")
    .action(async (options: HistoryRunsOptions) => handlers.runs(options));

  history
    .command("show")
    .description("Print a run's recorded output")
    .requiredOption("--workflow <key>", "Workflow lineage key")
    .requiredOption(
      "--run <ref|runId>",
      "Target run reference or numeric run ID"
    )
    .option("--step <index|final>", "Only show one step's attempts")
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option(
      "--json",
      "Emit NDJSON (one JSON object per line) attempt records instead of formatted text"
    )
    .option("--no-color", "Disable color in formatted output")
    .action(async (options: HistoryShowOptions) => handlers.show(options));
}
