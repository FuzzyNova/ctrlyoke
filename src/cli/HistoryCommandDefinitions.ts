import { Command } from "commander";

export interface HistoryPruneOptions {
  yes?: boolean;
}

export interface HistoryRelinkOptions {
  yes?: boolean;
}

export interface HistoryCommandHandlers {
  prune(options: HistoryPruneOptions): Promise<void>;
  relink(
    oldPath: string,
    newPath: string,
    options: HistoryRelinkOptions
  ): Promise<void>;
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
}
