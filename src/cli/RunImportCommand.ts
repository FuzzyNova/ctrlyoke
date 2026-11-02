import { Command } from "commander";
import * as path from "node:path";
import { RunBundleImporter } from "../core/orchestration/RunBundleImporter";
import { readRunBundleHeader } from "../core/orchestration/RunBundleReader";
import {
  bootstrapCliWorkspace,
  type CliWorkspaceBootstrap,
} from "./CliWorkspaceBootstrap";
import { CLI_USAGE_EXIT_CODE } from "./CliExitCode";

export interface RunImportOptions {
  bundleDir: string;
  name?: string;
  again?: boolean;
  cwd?: string;
  json?: boolean;
}

export interface RunImportCommandIo {
  writeOut(message: string): void;
}

export interface RunImportCommandDependencies {
  bootstrapCliWorkspace?: (
    options: Pick<RunImportOptions, "cwd">
  ) => Promise<CliWorkspaceBootstrap>;
  importer?: Pick<RunBundleImporter, "importRun">;
  readBundleHeader?: typeof readRunBundleHeader;
  setExitCode?: (code: number) => void;
}

export function registerImportCommand(
  program: Command,
  handler: (options: RunImportOptions) => Promise<void>
): void {
  program
    .command("import")
    .description("Import a run bundle into workspace history for viewing")
    .argument("<bundleDir>", "Run bundle directory to import")
    .option("--name <name>", "Name for the imported workflow lineage")
    .option("--again", "Import a bundle that was already imported")
    .option("-d, --cwd <path>", "Workspace root (default: current directory)")
    .option("--json", "Emit one versioned JSON result line")
    .action(
      async (bundleDir: string, options: Omit<RunImportOptions, "bundleDir">) =>
        handler({ ...options, bundleDir })
    );
}

export async function importRunCommand(
  options: RunImportOptions,
  io: RunImportCommandIo,
  dependencies: RunImportCommandDependencies = {}
): Promise<void> {
  try {
    const workspace = await (
      dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
    )({ cwd: options.cwd });
    const bundleDir = path.resolve(options.bundleDir);
    const header = await (dependencies.readBundleHeader ?? readRunBundleHeader)(
      bundleDir,
      workspace.workspaceRoot
    );
    const imported = await (
      dependencies.importer ?? new RunBundleImporter()
    ).importRun({
      workspaceRoot: workspace.workspaceRoot,
      bundleDir,
      ...(options.again === true ? { again: true } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
    });
    const descriptor = await workspace
      .createLineageRepository()
      .readDescriptor(workspace.workspaceRoot, imported.workflowKey);
    const runRef =
      imported.status === "imported"
        ? imported.runRef
        : descriptor.latestRunRef;
    const eventCount = header.runManifest.eventCount;
    const importedFrom = {
      sourceRoot: header.manifest.sourceRoot,
      exportedAt: header.manifest.exportedAt,
      exportedByVersion: header.manifest.exportedByVersion,
    };

    if (options.json) {
      io.writeOut(
        JSON.stringify({
          schemaVersion: 1,
          success: true,
          status: imported.status,
          workflowKey: imported.workflowKey,
          runRef: runRef ?? null,
          eventCount,
          importedFrom,
        })
      );
      return;
    }

    if (imported.status === "alreadyImported") {
      io.writeOut(
        `Already imported ${descriptor.workflowName} as ${imported.workflowKey} ${runRef ?? "(run reference unavailable)"}.`
      );
      io.writeOut("Pass --again to create another import.");
      return;
    }

    io.writeOut(
      `Imported ${descriptor.workflowName} as ${imported.workflowKey} ${imported.runRef}.`
    );
    io.writeOut(`  ${eventCount} events`);
    io.writeOut(`  Source: ${importedFrom.sourceRoot}`);
    io.writeOut(
      `  Exported: ${importedFrom.exportedAt} by ctrlyoke ${importedFrom.exportedByVersion}`
    );
    io.writeOut(
      `View it with: ctrlyoke history show --workflow ${imported.workflowKey} --run ${imported.runRef}`
    );
  } catch (error) {
    if (!options.json) throw error;
    const message = error instanceof Error ? error.message : String(error);
    io.writeOut(
      JSON.stringify({
        schemaVersion: 1,
        success: false,
        error: message,
      })
    );
    // Invalid bundle data is user input, and follows the CLI usage error code.
    (dependencies.setExitCode ?? ((code) => (process.exitCode = code)))(
      CLI_USAGE_EXIT_CODE
    );
  }
}
