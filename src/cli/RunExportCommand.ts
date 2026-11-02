import { Command } from "commander";
import * as os from "node:os";
import * as path from "node:path";
import { exportRunBundle } from "../core/orchestration/RunBundleExporter";
import { buildRunBundleExportOptions } from "../core/orchestration/RunBundleExportOptions";
import { RUN_BUNDLE_DIR_SUFFIX } from "../types/RunBundleTypes";
import {
  bootstrapCliWorkspace,
  type CliWorkspaceBootstrap,
} from "./CliWorkspaceBootstrap";
import {
  CLI_WORKFLOW_OPTION_DESCRIPTION,
  CLI_WORKFLOW_OPTION_FLAGS,
} from "./CliWorkflowOption";
import { resolveHistoryRun } from "./HistoryInspectionCommands";

export interface RunExportOptions {
  cwd?: string;
  workflow: string;
  run?: string;
  out: string;
  withSnapshots?: boolean;
  withStreamDeltas?: boolean;
  changes?: boolean;
  force?: boolean;
  json?: boolean;
}

export interface RunExportCommandIo {
  writeOut(message: string): void;
  writeErr(message: string): void;
}

export interface RunExportCommandDependencies {
  bootstrapCliWorkspace?: (
    options: Pick<RunExportOptions, "cwd">
  ) => Promise<CliWorkspaceBootstrap>;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function registerExportCommand(
  program: Command,
  handler: (options: RunExportOptions) => Promise<void>
): void {
  program
    .command("export")
    .description(
      "Export one settled run as a portable, redacted run bundle directory"
    )
    .requiredOption(CLI_WORKFLOW_OPTION_FLAGS, CLI_WORKFLOW_OPTION_DESCRIPTION)
    .option("--run <ref|runId>", "Target run (default: latest)")
    .requiredOption(
      "-o, --out <dir>",
      `Bundle directory to create (${RUN_BUNDLE_DIR_SUFFIX} is appended when missing)`
    )
    .option(
      "--with-snapshots",
      "Include workspace snapshots, which carry file contents (needed for diffs and Undo)"
    )
    .option(
      "--with-stream-deltas",
      "Keep per-chunk streaming text events (normally collapsed into final output)"
    )
    .option("--no-changes", "Omit the workspace changes patch")
    .option("-f, --force", "Replace an existing bundle at --out")
    .option(
      "-d, --cwd <path>",
      "Working directory (default: current directory)"
    )
    .option("--json", "Emit one versioned JSON result line")
    .action(async (options: RunExportOptions) => handler(options));
}

export async function exportRunCommand(
  version: string,
  options: RunExportOptions,
  io: RunExportCommandIo,
  dependencies: RunExportCommandDependencies = {}
): Promise<void> {
  const workspace = await (
    dependencies.bootstrapCliWorkspace ?? bootstrapCliWorkspace
  )({ cwd: options.cwd });
  const { workflowKey, runRef } = await resolveHistoryRun(
    workspace,
    io,
    options.workflow,
    options.run
  );
  const out = path.resolve(options.out);
  const result = await exportRunBundle(
    buildRunBundleExportOptions({
      stateRoot: workspace.workspaceRoot,
      workspaceRoot: workspace.workspaceRoot,
      workflowKey,
      runRef,
      bundleDir: out.endsWith(RUN_BUNDLE_DIR_SUFFIX)
        ? out
        : `${out}${RUN_BUNDLE_DIR_SUFFIX}`,
      exportedByVersion: version,
      includeSnapshots: options.withSnapshots === true,
      includeStreamDeltas: options.withStreamDeltas === true,
      includeChanges: options.changes !== false,
      onWarning: io.writeErr,
      environment: dependencies.environment,
      homeDir: dependencies.homeDir ?? os.homedir(),
      replace: options.force === true,
    })
  );

  const { redaction, externalPaths } = result.manifest;
  if (options.json) {
    io.writeOut(
      JSON.stringify({
        schemaVersion: 1,
        success: true,
        bundleDir: result.bundleDir,
        workflowKey,
        runRef,
        eventCount: result.eventCount,
        includesSnapshots: result.manifest.includesSnapshots,
        includesStreamDeltas: result.manifest.includesStreamDeltas === true,
        continuable: result.continuable,
        continuation: result.continuation ?? null,
        redaction,
        externalPaths,
        warnings: result.warnings,
      })
    );
    return;
  }
  io.writeOut(`Exported ${workflowKey} ${runRef} to ${result.bundleDir}`);
  io.writeOut(
    `  ${result.eventCount} events${result.manifest.includesSnapshots ? ", with workspace snapshots" : ""}${result.manifest.includesStreamDeltas ? ", with streaming deltas" : ""}`
  );
  io.writeOut(`  ${result.continuable ? "Continuable run" : "History only"}`);
  if (result.continuation) {
    const patch = result.continuation.workspace.patch;
    if (patch) {
      io.writeOut(`  ${patch.files} changed file(s) in ${patch.file}`);
      for (const file of result.changedFiles) io.writeOut(`    ${file}`);
    } else if (options.changes === false) {
      io.writeOut("  Workspace changes patch omitted (--no-changes)");
    }
  }
  for (const warning of result.warnings) {
    io.writeOut(`  Warning: ${warning}`);
  }
  const rules = Object.entries(redaction.byRule)
    .map(([rule, count]) => `${rule} ${count}`)
    .join(", ");
  io.writeOut(
    `  ${redaction.removedCount} value(s) redacted${rules ? ` (${rules})` : ""}`
  );
  const filesWithRedactions = Object.entries(redaction.byFile ?? {});
  if (filesWithRedactions.length > 1) {
    io.writeOut(
      `  By file: ${filesWithRedactions
        .map(([file, count]) => `${file} ${count}`)
        .join(", ")}`
    );
  }
  if (externalPaths.length > 0) {
    io.writeOut(`  Paths outside the workspace (left as written):`);
    for (const externalPath of externalPaths)
      io.writeOut(`    ${externalPath}`);
  }
  io.writeOut("Review the bundle before sharing it: redaction is best effort.");
}
