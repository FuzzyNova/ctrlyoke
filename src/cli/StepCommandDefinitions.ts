import { Command } from "commander";

export interface StepEditOptions {
  workflow: string;
  run: string;
  index: string;
  cwd?: string;
  prompt?: string;
  json?: boolean;
}

export interface StepRemoveOptions {
  workflow: string;
  run: string;
  index: string;
  cwd?: string;
  json?: boolean;
}

export interface StepReorderOptions {
  workflow: string;
  run: string;
  order: string;
  cwd?: string;
  json?: boolean;
}

export interface StepCommandHandlers {
  edit(file: string | undefined, options: StepEditOptions): Promise<void>;
  remove(options: StepRemoveOptions): Promise<void>;
  reorder(options: StepReorderOptions): Promise<void>;
}

/** Registers non-executing commands that mutate a named run's pending steps. */
export function registerStepCommands(
  program: Command,
  handlers: StepCommandHandlers
): void {
  const step = program
    .command("step")
    .description("Edit the pending steps in a persisted workflow run");

  step
    .command("edit [file]")
    .description("Edit one pending step's prompt or configuration")
    .requiredOption("--workflow <key>", "Workflow lineage key")
    .requiredOption(
      "--run <ref|runId>",
      "Target run reference or numeric run ID"
    )
    .requiredOption(
      "--index <index>",
      "Zero-based absolute index of the pending step"
    )
    .option(
      "-p, --prompt <text>",
      "Replace the step prompt (alternative to a one-step file)"
    )
    .option("-d, --cwd <path>", "Working directory (default: current directory)")
    .option("--json", "Output the mutation result as JSON")
    .action(async (file: string | undefined, options: StepEditOptions) =>
      handlers.edit(file, options)
    );

  step
    .command("remove")
    .description("Remove one pending step")
    .requiredOption("--workflow <key>", "Workflow lineage key")
    .requiredOption(
      "--run <ref|runId>",
      "Target run reference or numeric run ID"
    )
    .requiredOption(
      "--index <index>",
      "Zero-based absolute index of the pending step"
    )
    .option("-d, --cwd <path>", "Working directory (default: current directory)")
    .option("--json", "Output the mutation result as JSON")
    .action(async (options: StepRemoveOptions) => handlers.remove(options));

  step
    .command("reorder")
    .description("Reorder all pending steps")
    .requiredOption("--workflow <key>", "Workflow lineage key")
    .requiredOption(
      "--run <ref|runId>",
      "Target run reference or numeric run ID"
    )
    .requiredOption(
      "--order <indices>",
      "Comma-separated absolute zero-based indices in desired execution order"
    )
    .option("-d, --cwd <path>", "Working directory (default: current directory)")
    .option("--json", "Output the mutation result as JSON")
    .action(async (options: StepReorderOptions) =>
      handlers.reorder(options)
    );
}
