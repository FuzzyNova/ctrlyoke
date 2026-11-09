import { Command, Option } from "commander";
import * as path from "node:path";
import { RunBundleImporter } from "../core/orchestration/RunBundleImporter";
import { readRunBundleHeader } from "../core/orchestration/RunBundleReader";
import { RunImportPreviewService } from "../core/orchestration/RunImportPreview";
import type { RunImportPreview } from "../types/RunImportPreviewTypes";
import {
  bootstrapCliWorkspace,
  type CliWorkspaceBootstrap,
} from "./CliWorkspaceBootstrap";
import { CLI_USAGE_EXIT_CODE } from "./CliExitCode";
import { STEP_TYPES } from "../types/DashboardConstants";
import {
  RUN_CHANGES_TARGETS,
  RUN_IMPORT_STATUSES,
  type RunChangesTarget,
} from "../types/RunBundleTypes";
import { getErrorMessage } from "../utils/ErrorUtils";

export interface RunImportOptions {
  bundleDir: string;
  name?: string;
  again?: boolean;
  cwd?: string;
  json?: boolean;
  continue?: boolean;
  changes?: RunChangesTarget;
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
  previewService?: Pick<RunImportPreviewService, "preview">;
  setExitCode?: (code: number) => void;
  continueRun?: (
    workflowKey: string,
    runRef: string,
    cwd?: string
  ) => Promise<void>;
}

export function registerImportCommand(
  program: Command,
  handler: (options: RunImportOptions) => Promise<void>
): void {
  program
    .command("import")
    .description("Import a run bundle into workspace history")
    .argument("<bundleDir>", "Run bundle directory to import")
    .option("--name <name>", "Name for the imported workflow lineage")
    .option("--again", "Import a bundle that was already imported")
    .option("--continue", "Continue the imported run after a successful import")
    .addOption(
      new Option(
        "--changes <target>",
        "Place changes with worktree, checkout, or skip"
      ).choices(Object.values(RUN_CHANGES_TARGETS))
    )
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
    const preview = await (
      dependencies.previewService ?? new RunImportPreviewService()
    ).preview(bundleDir, workspace.workspaceRoot, {
      lineageRepository: workspace.createLineageRepository(),
    });
    if (!options.json) printImportPreview(preview, io);
    const imported = await (
      dependencies.importer ?? new RunBundleImporter()
    ).importRun({
      workspaceRoot: workspace.workspaceRoot,
      bundleDir,
      ...(options.again === true ? { again: true } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.changes ? { changes: options.changes } : {}),
    });
    const descriptor = await workspace
      .createLineageRepository()
      .readDescriptor(workspace.workspaceRoot, imported.workflowKey);
    const runRef =
      imported.status === RUN_IMPORT_STATUSES.IMPORTED
        ? imported.runRef
        : descriptor.latestRunRef;
    const eventCount = header.runManifest.eventCount;
    const importedFrom = {
      sourceRoot: header.manifest.sourceRoot,
      exportedAt: header.manifest.exportedAt,
      exportedByVersion: header.manifest.exportedByVersion,
    };
    const warnings: string[] = [];
    if (
      !header.manifest.continuation &&
      (options.continue || options.changes)
    ) {
      warnings.push(
        "This history-only bundle has no continuation data; --continue and --changes were ignored."
      );
    }
    if (
      imported.status === RUN_IMPORT_STATUSES.IMPORTED &&
      imported.placement?.warning
    )
      warnings.push(imported.placement.warning);
    for (const warning of warnings)
      if (!options.json) io.writeOut(`Warning: ${warning}`);
    let continued = false;
    if (
      options.continue &&
      header.manifest.continuation &&
      imported.status === RUN_IMPORT_STATUSES.IMPORTED &&
      imported.placement?.canContinue !== false &&
      (imported.placement?.target === RUN_CHANGES_TARGETS.SKIP ||
        imported.placement?.applied !== false) &&
      dependencies.continueRun
    ) {
      await dependencies.continueRun(
        imported.workflowKey,
        imported.runRef,
        options.cwd
      );
      continued = true;
    }

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
          changes:
            imported.status === RUN_IMPORT_STATUSES.IMPORTED &&
            imported.placement
              ? {
                  target: imported.placement.target,
                  applied: imported.placement.applied,
                  worktreePath: imported.placement.worktreePath ?? null,
                }
              : null,
          continued,
          warnings,
          preview,
        })
      );
      return;
    }

    if (imported.status === RUN_IMPORT_STATUSES.ALREADY_IMPORTED) {
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
    if (continued) io.writeOut("Continuing imported run.");
  } catch (error) {
    if (!options.json) throw error;
    const message = getErrorMessage(error);
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

function printImportPreview(
  preview: RunImportPreview,
  io: RunImportCommandIo
): void {
  io.writeOut(`Import preview: ${preview.provenance.workflowName}`);
  io.writeOut(`  Source: ${preview.provenance.sourceRoot}`);
  io.writeOut(
    `  Exported: ${preview.provenance.exportedAt} by ctrlyoke ${preview.provenance.exportedByVersion}`
  );
  if (preview.provenance.alreadyImported) {
    io.writeOut(
      `  Already imported as ${preview.provenance.alreadyImported.workflowKey}${preview.provenance.alreadyImported.runRef ? ` ${preview.provenance.alreadyImported.runRef}` : ""}`
    );
  }
  for (const warning of preview.warnings ?? [])
    io.writeOut(`  Warning: ${warning}`);
  if (preview.continuation) {
    const {
      baseCommit,
      worktreeMode,
      defaultChangesTarget,
      patchFileCount,
      checkoutClean,
      checkoutAtBaseCommit,
    } = preview.continuation;
    io.writeOut(
      `  Continuable: ${worktreeMode}; changes default to ${defaultChangesTarget}; ${patchFileCount} patch files`
    );
    io.writeOut(
      `  Base commit ${baseCommit.commit.slice(0, 7)}: ${baseCommit.exists ? "available" : baseCommit.instruction}; checkout ${checkoutClean ? "clean" : "dirty"} and ${checkoutAtBaseCommit ? "at base" : "not at base"}`
    );
  } else {
    io.writeOut("  View-only bundle");
  }
  for (const step of preview.pendingSteps) {
    io.writeOut(
      `  Pending ${step.kind} step ${step.stepIndex + 1}${step.name ? ` (${step.name})` : ""}${step.promptRedacted ? " [prompt redacted]" : ""}`
    );
    if (step.kind === STEP_TYPES.PROMPT)
      io.writeOut(
        `    ${step.harness ?? "default"}${step.model ? ` / ${step.model}` : ""}${step.previouslyUsed ? ` (used ${step.previouslyUsed.harness ?? "?"}${step.previouslyUsed.model ? ` / ${step.previouslyUsed.model}` : ""})` : ""}`
      );
    if (step.promptPreview) io.writeOut(`    ${step.promptPreview}`);
    if (step.additionalArgs)
      io.writeOut(`    Additional arguments: ${step.additionalArgs}`);
    if (step.mcpServers?.length)
      io.writeOut(
        `    MCP servers: ${step.mcpServers.map((server) => (typeof server === "string" ? server : server.id)).join(", ")}`
      );
    for (const grant of step.secretGrants)
      io.writeOut(
        `    Secret ${grant.name}: ${grant.approved ? "approved" : "needs approval"}`
      );
    if (step.script) io.writeOut(`    Script: ${step.script.script}`);
    if (step.preCondition)
      io.writeOut(`    Pre-condition: ${step.preCondition.script}`);
    if (step.endCondition)
      io.writeOut(`    End-condition: ${step.endCondition.script}`);
  }
  for (const session of preview.sessions) {
    io.writeOut(
      `  Session for step ${session.stepIndex + 1}${session.sessionId ? ` (${session.sessionId})` : ""}: ${session.availability}${session.notFromThisRun ? " (not from this run)" : ""}${session.executedStepIndices.length ? `; used by steps ${session.executedStepIndices.map((index) => index + 1).join(", ")}` : ""}`
    );
    if (session.hint) io.writeOut(`    ${session.hint}`);
  }
  for (const blocker of preview.blockers)
    io.writeOut(`  Blocker: ${blocker.message}`);
}
