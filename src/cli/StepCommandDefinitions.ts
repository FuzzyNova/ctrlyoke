import { Command } from "commander";
import {
  CLI_WORKFLOW_OPTION_DESCRIPTION,
  CLI_WORKFLOW_OPTION_FLAGS,
} from "./CliWorkflowOption";

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

export interface StepDefinitionReviewOptions {
  workflow: string;
  run: string;
  cwd?: string;
  json?: boolean;
}

export interface StepCommandHandlers {
  edit(file: string | undefined, options: StepEditOptions): Promise<void>;
  remove(options: StepRemoveOptions): Promise<void>;
  reorder(options: StepReorderOptions): Promise<void>;
  acceptDefinition(options: StepDefinitionReviewOptions): Promise<void>;
  restoreDefinition(options: StepDefinitionReviewOptions): Promise<void>;
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
    .requiredOption(CLI_WORKFLOW_OPTION_FLAGS, CLI_WORKFLOW_OPTION_DESCRIPTION)
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
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--json", "Output the mutation result as JSON")
    .action(async (file: string | undefined, options: StepEditOptions) =>
      handlers.edit(file, options)
    );

  step
    .command("remove")
    .description("Remove one pending step")
    .requiredOption(CLI_WORKFLOW_OPTION_FLAGS, CLI_WORKFLOW_OPTION_DESCRIPTION)
    .requiredOption(
      "--run <ref|runId>",
      "Target run reference or numeric run ID"
    )
    .requiredOption(
      "--index <index>",
      "Zero-based absolute index of the pending step"
    )
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--json", "Output the mutation result as JSON")
    .action(async (options: StepRemoveOptions) => handlers.remove(options));

  step
    .command("reorder")
    .description("Reorder all pending steps")
    .requiredOption(CLI_WORKFLOW_OPTION_FLAGS, CLI_WORKFLOW_OPTION_DESCRIPTION)
    .requiredOption(
      "--run <ref|runId>",
      "Target run reference or numeric run ID"
    )
    .requiredOption(
      "--order <indices>",
      "Comma-separated absolute zero-based indices in desired execution order"
    )
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--json", "Output the mutation result as JSON")
    .action(async (options: StepReorderOptions) => handlers.reorder(options));

  // A run whose definition was changed outside ctrlyoke refuses every run and
  // edit until one of these answers it.
  const definitionReview: ReadonlyArray<{
    name: string;
    description: string;
    handler: (options: StepDefinitionReviewOptions) => Promise<void>;
  }> = [
    {
      name: "accept-definition",
      description:
        "Trust a run definition that was changed outside ctrlyoke, as it is now",
      handler: (options) => handlers.acceptDefinition(options),
    },
    {
      name: "restore-definition",
      description:
        "Discard changes made outside ctrlyoke and restore the definition ctrlyoke last wrote",
      handler: (options) => handlers.restoreDefinition(options),
    },
  ];
  for (const { name, description, handler } of definitionReview) {
    step
      .command(name)
      .description(description)
      .requiredOption(
        CLI_WORKFLOW_OPTION_FLAGS,
        CLI_WORKFLOW_OPTION_DESCRIPTION
      )
      .requiredOption(
        "--run <ref|runId>",
        "Target run reference or numeric run ID"
      )
      .option(
        "-d, --cwd <path>",
        "Working directory (default: current directory)"
      )
      .option("--json", "Output the result as JSON")
      .action(async (options: StepDefinitionReviewOptions) => handler(options));
  }
}
