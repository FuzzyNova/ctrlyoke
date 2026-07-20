#!/usr/bin/env node
/**
 * dev/migrate-runs-layout.mjs
 *
 * THROWAWAY, MANUAL-RUN-ONLY migration script for the "working file per run"
 * refactor (dev/backlog/WORKING_FILE_PER_RUN_PLAN.md). Converts a workspace's
 * pre-refactor `.ctrlyoke/.working/*.ctrlyoke.json` + `.ctrlyoke/.history/<id>/`
 * layout into the new `.ctrlyoke/.runs/<workflowKey>/` layout.
 *
 * Not bundled, not invoked by the extension. Run manually per workspace:
 *
 *   node dev/migrate-runs-layout.mjs <workspaceRoot> [--dry-run] [--cleanup]
 *
 * Phases:
 *   1. (default) Convert: create `.runs/<workflowKey>/` lineages from `.working/`
 *      + `.history/`, without touching or deleting the old directories. Prints a
 *      per-lineage success/warning/failure report. Safe to re-run — it refuses to
 *      overwrite an existing `.runs/<workflowKey>` destination.
 *   2. `--cleanup`: after you've verified the new `.runs/` layout looks correct,
 *      re-run with this flag to delete the old `.working/`/`.history/` directories
 *      (and stale `.runner.json` locks). This is the only destructive step.
 *
 * An orphan `.history/<id>/` directory with no matching `.working/<id>.ctrlyoke.json`
 * cannot satisfy the new run invariant (a run needs a definition file). Those are
 * moved to `.ctrlyoke/.migration-rejected/<id>/` instead of being silently dropped
 * or given an invented empty definition.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

const CTRLYOKE_DIR = ".ctrlyoke";
const WORKING_DIR = ".working";
const HISTORY_DIR = ".history";
const RUNS_DIR = ".runs";
const REJECTED_DIR = ".migration-rejected";
const WORKING_FILE_NAME = "workflow.ctrlyoke.json";
const DESCRIPTOR_FILE_NAME = "workflow.json";
const RUNNER_LOCK_FILE_NAME = "runner.json";
const DRAFT_DIR_NAME = "draft";
const MANIFEST_FILE_NAME = "manifest.json";

function usageAndExit(message) {
  if (message) console.error(`Error: ${message}`);
  console.error(
    "Usage: node dev/migrate-runs-layout.mjs <workspaceRoot> [--dry-run] [--cleanup]"
  );
  process.exit(message ? 2 : 0);
}

const args = process.argv.slice(2);
const workspaceRoot = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const cleanup = args.includes("--cleanup");

if (!workspaceRoot) usageAndExit("workspaceRoot is required");
const resolvedRoot = path.resolve(workspaceRoot);
if (!fsSync.existsSync(resolvedRoot)) {
  usageAndExit(`workspaceRoot does not exist: ${resolvedRoot}`);
}

const ctrlyokeDir = path.join(resolvedRoot, CTRLYOKE_DIR);
const workingDir = path.join(ctrlyokeDir, WORKING_DIR);
const historyBaseDir = path.join(ctrlyokeDir, HISTORY_DIR);
const runsRoot = path.join(ctrlyokeDir, RUNS_DIR);
const rejectedRoot = path.join(ctrlyokeDir, REJECTED_DIR);

/** Mirrors TimelineRecorder.extractRunTimestamp / WorkflowPaths.parseRunRefTimestamp. */
function extractRunTimestamp(entryName) {
  const match = entryName.match(
    /^run-(?:\d+-)?(\d{4}-\d{2}-\d{2}T[\d-]+Z?)(?:\.json)?$/
  );
  if (!match) return 0;
  const restored = match[1].replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z?)$/,
    "$1$2:$3:$4.$5"
  );
  const ms = new Date(restored).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function formatRunRef(timestampMs) {
  return `run-${new Date(timestampMs).toISOString().replace(/[:.]/g, "-")}`;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

function extractWorkflowId(workingFileName) {
  return workingFileName
    .replace(/\.ctrlyoke\.json$/, "")
    .replace(/\.ctrlyoke\.yaml$/, "")
    .replace(/\.ctrlyoke\.yml$/, "");
}

/** Lists a `.history/<id>/` directory's run entries, newest first, alongside their manifest paths. */
async function listHistoryRuns(historyDir) {
  let entries;
  try {
    entries = await fs.readdir(historyDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = entries
    .filter(
      (e) =>
        (e.isDirectory() && /^run-/.test(e.name)) ||
        (e.isFile() && /^run-.*\.json$/.test(e.name))
    )
    .map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      timestamp: extractRunTimestamp(e.name),
      sourcePath: path.join(historyDir, e.name),
      manifestPath: e.isDirectory()
        ? path.join(historyDir, e.name, MANIFEST_FILE_NAME)
        : path.join(historyDir, e.name),
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
  return runs;
}

/** Runtime-strips a working-file-shaped object for use as an "approximate" older-run definition copy. */
function stripRuntimeForApproximateCopy(workingFile) {
  const { _runtime, steps, ...rest } = workingFile;
  return {
    ...rest,
    steps: Array.isArray(steps)
      ? steps.map(({ _runtime: _stepRuntime, ...stepRest }) => stepRest)
      : steps,
  };
}

async function convertLineage(workflowId, report) {
  const workingFilePath = path.join(
    workingDir,
    `${workflowId}.ctrlyoke.json`
  );
  const workflowKey = workflowId; // Old basename already is a valid sanitized-slug+timestamp key.
  const lineageDir = path.join(runsRoot, workflowKey);

  if (await pathExists(lineageDir)) {
    report.warnings.push(
      `${workflowId}: destination .runs/${workflowKey} already exists — skipped (already migrated?)`
    );
    return;
  }

  let workingFile;
  try {
    workingFile = await readJson(workingFilePath);
  } catch (error) {
    report.failures.push(
      `${workflowId}: failed to read working file: ${error.message}`
    );
    return;
  }

  const historyDir = path.join(historyBaseDir, workflowId);
  const historyRuns = await listHistoryRuns(historyDir);

  if (dryRun) {
    report.successes.push(
      `${workflowId}: [dry-run] would create lineage with ${historyRuns.length} run(s)` +
        (historyRuns.length === 0 ? " (draft only)" : "")
    );
    return;
  }

  const now = Date.now();
  const stagingDir = path.join(runsRoot, `.creating-${workflowId}-${now}`);
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    if (historyRuns.length === 0) {
      // No history at all — this lineage never executed. Seed a draft instead of a run.
      await writeJson(
        path.join(stagingDir, DRAFT_DIR_NAME, WORKING_FILE_NAME),
        workingFile
      );
      const descriptor = {
        schemaVersion: 1,
        workflowKey,
        workflowName: workingFile.workflowName ?? workflowId,
        ...(workingFile.originalFile
          ? { originalFile: workingFile.originalFile }
          : {}),
        isFavorite: workingFile.isFavorite ?? false,
        createdAt: workingFile.startedAt ?? now,
        lastModifiedAt: workingFile.lastModifiedAt ?? now,
        nextRunId: 1,
        revision: 1,
      };
      await writeJson(
        path.join(stagingDir, DESCRIPTOR_FILE_NAME),
        descriptor
      );
      await fs.rename(stagingDir, lineageDir);
      report.successes.push(
        `${workflowId}: migrated as a draft-only lineage (no history found)`
      );
      return;
    }

    // Newest history run gets the exact working file (definition + runtime) —
    // it's the one whose in-memory definition the old singleton still reflected.
    const runRefTimestamps = new Map();
    let nextRunId = 1;
    for (const run of historyRuns.slice().reverse()) {
      // oldest → newest, so runId order matches chronological order
      const isNewest = run === historyRuns[0];
      const runRef = formatRunRef(run.timestamp || now);
      runRefTimestamps.set(run, runRef);
      const runDir = path.join(stagingDir, runRef);
      await fs.mkdir(runDir, { recursive: true });

      // Copy manifest.json + events.jsonl if present (directory-form runs only;
      // legacy bare-file runs predate the timeline format and have no companion events file).
      if (run.isDirectory) {
        const eventsSrc = path.join(run.sourcePath, "events.jsonl");
        await fs
          .copyFile(run.manifestPath, path.join(runDir, MANIFEST_FILE_NAME))
          .catch((e) =>
            report.warnings.push(
              `${workflowId}/${run.name}: could not copy manifest: ${e.message}`
            )
          );
        await fs
          .copyFile(eventsSrc, path.join(runDir, "events.jsonl"))
          .catch(() => {
            /* legacy runs may not have events.jsonl — not fatal */
          });
      } else {
        await fs
          .copyFile(run.sourcePath, path.join(runDir, MANIFEST_FILE_NAME))
          .catch((e) =>
            report.warnings.push(
              `${workflowId}/${run.name}: could not copy legacy manifest: ${e.message}`
            )
          );
      }

      if (isNewest) {
        await writeJson(
          path.join(runDir, WORKING_FILE_NAME),
          { ...workingFile, definitionRevision: 1 }
        );
      } else {
        // Older runs: the old layout never stored their exact historical definition —
        // only the newest working file survived. Mark this copy as approximate.
        await writeJson(path.join(runDir, WORKING_FILE_NAME), {
          ...stripRuntimeForApproximateCopy(workingFile),
          definitionRevision: 1,
          _migrationNote:
            "APPROXIMATE: reconstructed from the lineage's final working file; " +
            "this run's exact historical definition was not recoverable from the pre-refactor layout.",
        });
        report.warnings.push(
          `${workflowId}/${run.name}: definition is APPROXIMATE (older run, exact definition not recoverable)`
        );
      }
      nextRunId += 1;
    }

    const newestRun = historyRuns[0];
    const latestRunRef = runRefTimestamps.get(newestRun);

    const descriptor = {
      schemaVersion: 1,
      workflowKey,
      workflowName: workingFile.workflowName ?? workflowId,
      ...(workingFile.originalFile
        ? { originalFile: workingFile.originalFile }
        : {}),
      isFavorite: workingFile.isFavorite ?? false,
      createdAt: workingFile.startedAt ?? now,
      lastModifiedAt: workingFile.lastModifiedAt ?? now,
      latestRunRef,
      nextRunId,
      revision: 1,
    };
    await writeJson(path.join(stagingDir, DESCRIPTOR_FILE_NAME), descriptor);

    // Verify every expected destination exists before promoting.
    for (const run of historyRuns) {
      const runRef = runRefTimestamps.get(run);
      const runFile = path.join(stagingDir, runRef, WORKING_FILE_NAME);
      if (!(await pathExists(runFile))) {
        throw new Error(`verification failed: missing ${runFile}`);
      }
    }
    await fs.rename(stagingDir, lineageDir);
    report.successes.push(
      `${workflowId}: migrated ${historyRuns.length} run(s), latest=${latestRunRef}`
    );
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    report.failures.push(`${workflowId}: ${error.message}`);
  }
}

async function quarantineOrphanHistory(workflowId, report) {
  const historyDir = path.join(historyBaseDir, workflowId);
  if (dryRun) {
    report.warnings.push(
      `${workflowId}: [dry-run] orphan history (no working file) would be quarantined to .migration-rejected/`
    );
    return;
  }
  const destination = path.join(rejectedRoot, workflowId);
  if (await pathExists(destination)) {
    report.warnings.push(
      `${workflowId}: orphan history quarantine destination already exists — skipped`
    );
    return;
  }
  await fs.mkdir(rejectedRoot, { recursive: true });
  await fs.rename(historyDir, destination);
  report.warnings.push(
    `${workflowId}: orphan history (no matching working file) quarantined to .migration-rejected/${workflowId}`
  );
}

async function runConvertPhase() {
  const report = { successes: [], warnings: [], failures: [] };

  let workingFiles = [];
  try {
    workingFiles = (await fs.readdir(workingDir)).filter((f) =>
      f.endsWith(".ctrlyoke.json")
    );
  } catch {
    console.log(`No ${WORKING_DIR}/ directory found — nothing to convert.`);
  }

  const workflowIds = new Set(workingFiles.map(extractWorkflowId));

  for (const workflowId of workflowIds) {
    await convertLineage(workflowId, report);
  }

  // Orphan history: a history lineage with no matching working file.
  let historyLineages = [];
  try {
    historyLineages = await fs.readdir(historyBaseDir);
  } catch {
    /* no history directory at all — fine */
  }
  for (const workflowId of historyLineages) {
    if (!workflowIds.has(workflowId)) {
      await quarantineOrphanHistory(workflowId, report);
    }
  }

  console.log("\n=== Migration report ===");
  console.log(`Successes (${report.successes.length}):`);
  report.successes.forEach((m) => console.log(`  ✓ ${m}`));
  console.log(`Warnings (${report.warnings.length}):`);
  report.warnings.forEach((m) => console.log(`  ! ${m}`));
  console.log(`Failures (${report.failures.length}):`);
  report.failures.forEach((m) => console.log(`  ✗ ${m}`));

  if (dryRun) {
    console.log(
      "\nDry run only — nothing was written. Re-run without --dry-run to convert."
    );
  } else if (report.failures.length === 0) {
    console.log(
      "\nConversion complete. Verify .ctrlyoke/.runs/ looks correct, then re-run with --cleanup to remove the old .working/.history directories."
    );
  } else {
    console.log(
      "\nSome lineages failed to convert — inspect them before running --cleanup."
    );
  }
}

async function runCleanupPhase() {
  if (!(await pathExists(runsRoot))) {
    usageAndExit(
      "No .ctrlyoke/.runs/ directory found — run the convert phase first."
    );
  }
  console.log(
    `This will permanently delete:\n  ${workingDir}\n  ${historyBaseDir}\nand any stale *.runner.json locks alongside .working/ entries.`
  );
  if (dryRun) {
    console.log("[dry-run] would delete the above directories.");
    return;
  }
  await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(historyBaseDir, { recursive: true, force: true }).catch(() => {});
  console.log("Cleanup complete.");
}

if (cleanup) {
  await runCleanupPhase();
} else {
  await runConvertPhase();
}
