import { Command } from "commander";
import {
  CTRLYOKE_ENV_VARS,
  EXECUTION_STATES,
  HARNESS_IDS,
  HISTORY_EVENT_KINDS,
} from "../types/DashboardConstants";

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

export interface HistorySearchOptions {
  cwd?: string;
  workflow?: string[];
  thisWorkflow?: boolean;
  kind?: string[];
  harness?: string[];
  state?: string[];
  path?: string;
  since?: string;
  until?: string;
  deep?: boolean;
  regex?: boolean;
  limit?: string;
  offset?: string;
  snippet?: string;
  exactCount?: boolean;
  rebuild?: boolean;
  fallback?: boolean;
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
  search(query: string, options: HistorySearchOptions): Promise<void>;
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
      "Emit NDJSON (one JSON object per line) attempt records; history search --json emits one versioned JSON result blob"
    )
    .option("--no-color", "Disable color in formatted output")
    .action(async (options: HistoryShowOptions) => handlers.show(options));

  history
    .command("search <query>")
    .description("Search recorded output across this workspace's run history")
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--workflow <key...>", "Restrict to workflow lineage keys")
    .option(
      "--this-workflow",
      `Restrict to the workflow named by ${CTRLYOKE_ENV_VARS.WORKING_FILE}`
    )
    .option(
      "--kind <kind...>",
      `Restrict to event kinds (valid values: ${Object.values(HISTORY_EVENT_KINDS).join(", ")})`
    )
    .option(
      "--harness <id...>",
      `Restrict to harnesses (valid values: ${Object.values(HARNESS_IDS).join(", ")})`
    )
    .option(
      "--state <state...>",
      `Restrict to run outcomes (valid values: ${Object.values(EXECUTION_STATES).join(", ")}); only settled outcomes (completed, error, stopped, paused) are normally persisted, so idle/pausing/cancelling match nothing`
    )
    .option("--path <substring>", "Restrict to events touching a file path")
    .option(
      "--since <when>",
      "Runs started at or after ISO-8601 or relative 7d/24h/30m"
    )
    .option(
      "--until <when>",
      "Runs started at or before ISO-8601 or relative 7d/24h/30m"
    )
    .option(
      "--deep",
      "Re-read matching runs past the 2000-character indexed text cap"
    )
    .option(
      "--regex",
      "Interpret the query as a case-insensitive regular expression"
    )
    .option("--limit <n>", "Maximum results (default 20, maximum 100)")
    .option(
      "--offset <n>",
      "Absolute result offset; cold processes re-derive skipped results"
    )
    .option("--snippet <chars>", "Context characters around each match")
    .option(
      "--exact-count",
      "Scan the whole history for an exact total; otherwise the total is a lower bound"
    )
    .option("--no-rebuild", "Search the existing index without rebuilding")
    .option(
      "--no-fallback",
      "Fail rather than serving results from the unindexed disk scan"
    )
    .option(
      "--json",
      "Emit one versioned JSON result blob (history show --json emits NDJSON)"
    )
    .option("--no-color", "Disable color in formatted output")
    .addHelpText(
      "after",
      "\nA result is one matching event or field, not one occurrence. Without --deep, indexed text is capped at 2000 characters. Regex matching is case-insensitive and may be slower than substring matching because the prefilter can only use an extracted literal. A zero-result search is exact but reads the whole index and may be slow. --offset is not cheap from a cold process. Only settled outcomes (completed, error, stopped, paused) are normally persisted; idle, pausing, and cancelling are transient.\n"
    )
    .action(async (query: string, options: HistorySearchOptions) =>
      handlers.search(query, options)
    );
}
