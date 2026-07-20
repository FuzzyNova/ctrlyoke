#!/usr/bin/env node
/**
 * One-time migration for ctrlyoke's pre-run-scoped developer data.
 *
 * Usage:
 *   node migrate-runs-layout.mjs [repository-path] [--apply]
 *
 * With no repository path, the current directory is used. The default is a
 * no-write dry run; pass --apply only after reviewing its report. This script
 * has no project imports, so it may be copied to another ctrlyoke workspace.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const WORKING_FILE_SUFFIX = ".ctrlyoke.json";
const RUN_FILE_NAME = "workflow.ctrlyoke.json";
const DESCRIPTOR_FILE_NAME = "workflow.json";
const MANIFEST_FILE_NAME = "manifest.json";
const EVENTS_FILE_NAME = "events.jsonl";
const RUNNER_LOCK_SUFFIX = ".runner.json";
const DESCRIPTOR_SCHEMA_VERSION = 1;
const TIMELINE_SCHEMA_VERSION = "2.2.0";
const EXECUTION_STATE_FALLBACK = "completed";
const RESERVED_WINDOWS_NAMES = new Set([
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5",
  "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5",
  "lpt6", "lpt7", "lpt8", "lpt9",
]);

function usage(error) {
  if (error) console.error(`Error: ${error}\n`);
  console.log("Usage: node migrate-runs-layout.mjs [repository-path] [--apply]");
  process.exit(error ? 1 : 0);
}

function parseArguments(argv) {
  let apply = false;
  let repositoryPath;
  for (const argument of argv) {
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
    } else if (argument.startsWith("-")) {
      usage(`Unknown option: ${argument}`);
    } else if (repositoryPath) {
      usage("Only one repository path may be supplied.");
    } else {
      repositoryPath = argument;
    }
  }
  return { apply, workspaceRoot: path.resolve(repositoryPath ?? process.cwd()) };
}

function workflowKeyFromLegacyId(legacyId) {
  const sanitized = legacyId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
  const base = RESERVED_WINDOWS_NAMES.has(sanitized.split(".")[0])
    ? `workflow-${sanitized}`
    : sanitized;
  return base;
}

function formatRunRef(timestampMs) {
  return `run-${new Date(timestampMs).toISOString().replace(/[:.]/g, "-")}`;
}

function parseLegacyRunTimestamp(name) {
  const match = /^run-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z?)/.exec(name);
  if (!match) return undefined;
  const restored = match[1].replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?(Z?)$/,
    (_all, prefix, hours, minutes, seconds, milliseconds = "000", z = "Z") =>
      `${prefix}${hours}:${minutes}:${seconds}.${milliseconds}${z || "Z"}`
  );
  const timestamp = new Date(restored).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function removeRuntime(value) {
  if (Array.isArray(value)) return value.map(removeRuntime);
  if (!value || typeof value !== "object") return value;
  const clone = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "_runtime") clone[key] = removeRuntime(child);
  }
  return clone;
}

function approximateDefinition(working) {
  return {
    ...removeRuntime(working),
    _migrationNote:
      "APPROXIMATE: reconstructed from the lineage's final working file; " +
      "this run's exact historical definition was not recoverable from the pre-run layout.",
  };
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function realDirectoryEntries(directory) {
  if (!directory) return [];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.lstat(fullPath);
      if (!stat.isSymbolicLink()) result.push({ entry, fullPath });
    }
    return result;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} (${filePath}): ${error.message}`);
  }
}

async function allocateWorkflowKey(runsRoot, legacyId, reservedKeys) {
  const base = workflowKeyFromLegacyId(legacyId);
  for (let ordinal = 1; ordinal <= 1000; ordinal += 1) {
    const candidate = ordinal === 1 ? base : `${base}-${ordinal}`;
    const collisionKey = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (reservedKeys.has(collisionKey)) continue;
    if (await exists(path.join(runsRoot, candidate))) continue;
    reservedKeys.add(collisionKey);
    return candidate;
  }
  throw new Error(`Could not allocate a workflow key for ${legacyId}`);
}

async function countTimelineEvents(eventsPath) {
  if (!(await exists(eventsPath))) return { eventCount: 0, nextSequence: 1 };
  const lines = (await fs.readFile(eventsPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let maxSequence = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (typeof event.sequence === "number") maxSequence = Math.max(maxSequence, event.sequence);
    } catch {
      // Preserve malformed historical content. Runtime readers already tolerate a
      // truncated final event; the report marks this run as approximate.
    }
  }
  return { eventCount: lines.length, nextSequence: maxSequence + 1 };
}

async function normalizeManifest({ runDirectory, workflowKey, runId, startedAt, stepCount }) {
  const manifestPath = path.join(runDirectory, MANIFEST_FILE_NAME);
  const existing = (await exists(manifestPath))
    ? await readJson(manifestPath, "legacy manifest")
    : {};
  const eventsPath = path.join(runDirectory, EVENTS_FILE_NAME);
  if (!(await exists(eventsPath))) await fs.writeFile(eventsPath, "", "utf8");
  const { eventCount, nextSequence } = await countTimelineEvents(eventsPath);
  const normalized = {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    storageKind: "timeline",
    workflowId: workflowKey,
    runId,
    startedAt: Number.isFinite(existing.startedAt) ? existing.startedAt : startedAt,
    ...(Number.isFinite(existing.completedAt) ? { completedAt: existing.completedAt } : {}),
    executionState: typeof existing.executionState === "string"
      ? existing.executionState
      : EXECUTION_STATE_FALLBACK,
    definitionRevision: 1,
    stepCount: Number.isFinite(existing.stepCount) ? existing.stepCount : stepCount,
    eventCount,
    nextSequence,
    lastUpdatedAt: Number.isFinite(existing.lastUpdatedAt)
      ? existing.lastUpdatedAt
      : startedAt,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function verifyLineage(lineageDirectory, hasRuns) {
  const descriptor = await readJson(path.join(lineageDirectory, DESCRIPTOR_FILE_NAME), "descriptor");
  if (!descriptor.workflowKey || !Number.isInteger(descriptor.nextRunId)) {
    throw new Error("Descriptor is missing its workflow key or next run id.");
  }
  const entries = await realDirectoryEntries(lineageDirectory);
  const runDirectories = entries.filter(({ entry }) => entry.isDirectory() && /^run-/.test(entry.name));
  if (hasRuns && runDirectories.length === 0) throw new Error("No promoted runs were staged.");
  if (!hasRuns && !(await exists(path.join(lineageDirectory, "draft", RUN_FILE_NAME)))) {
    throw new Error("Draft working file was not staged.");
  }
  for (const { fullPath } of runDirectories) {
    for (const fileName of [RUN_FILE_NAME, MANIFEST_FILE_NAME, EVENTS_FILE_NAME]) {
      if (!(await exists(path.join(fullPath, fileName)))) {
        throw new Error(`Staged run is missing ${fileName}.`);
      }
    }
    await readJson(path.join(fullPath, RUN_FILE_NAME), "staged run definition");
    await readJson(path.join(fullPath, MANIFEST_FILE_NAME), "staged manifest");
  }
}

async function buildLineage({ stagingDirectory, workflowKey, workingFile, historyDirectory }) {
  const working = await readJson(workingFile, "legacy working file");
  const historyEntries = (await realDirectoryEntries(historyDirectory))
    .filter(({ entry }) =>
      (entry.isDirectory() && entry.name.startsWith("run-")) ||
      (entry.isFile() && /^run-.*\.json$/.test(entry.name))
    )
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));
  const usedRunRefs = new Set();
  const stagedRuns = [];
  for (let index = 0; index < historyEntries.length; index += 1) {
    const source = historyEntries[index];
    const sourceManifestPath = source.entry.isDirectory()
      ? path.join(source.fullPath, MANIFEST_FILE_NAME)
      : source.fullPath;
    const sourceManifest = await readJson(sourceManifestPath, "legacy manifest");
    const baseTimestamp = Number.isFinite(sourceManifest.startedAt)
      ? sourceManifest.startedAt
      : parseLegacyRunTimestamp(source.entry.name) ?? Date.now() + index;
    let offset = 0;
    let runRef = formatRunRef(baseTimestamp);
    while (usedRunRefs.has(runRef)) runRef = formatRunRef(baseTimestamp + ++offset);
    usedRunRefs.add(runRef);
    const destination = path.join(stagingDirectory, runRef);
    if (source.entry.isDirectory()) {
      await fs.cp(source.fullPath, destination, { recursive: true, errorOnExist: true, force: false });
    } else {
      await fs.mkdir(destination);
      await fs.copyFile(sourceManifestPath, path.join(destination, MANIFEST_FILE_NAME));
    }
    await fs.writeFile(
      path.join(destination, RUN_FILE_NAME),
      `${JSON.stringify(approximateDefinition(working), null, 2)}\n`,
      "utf8"
    );
    await normalizeManifest({
      runDirectory: destination,
      workflowKey,
      runId: index + 1,
      startedAt: baseTimestamp,
      stepCount: Array.isArray(working.steps) ? working.steps.length : 0,
    });
    stagedRuns.push({ runRef, timestamp: baseTimestamp, destination });
  }

  if (stagedRuns.length > 0) {
    const newest = [...stagedRuns].sort((left, right) => right.timestamp - left.timestamp)[0];
    await fs.writeFile(path.join(newest.destination, RUN_FILE_NAME), `${JSON.stringify(working, null, 2)}\n`, "utf8");
  } else {
    const draftDirectory = path.join(stagingDirectory, "draft");
    await fs.mkdir(draftDirectory);
    await fs.writeFile(path.join(draftDirectory, RUN_FILE_NAME), `${JSON.stringify(working, null, 2)}\n`, "utf8");
  }

  const latest = [...stagedRuns].sort((left, right) => right.timestamp - left.timestamp)[0];
  const createdAt = Math.min(
    Number.isFinite(working.startedAt) ? working.startedAt : Date.now(),
    ...stagedRuns.map((run) => run.timestamp)
  );
  const descriptor = {
    schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
    workflowKey,
    workflowName: typeof working.workflowName === "string" && working.workflowName.trim()
      ? working.workflowName
      : workflowKey,
    ...(typeof working.originalFile === "string" && working.originalFile ? { originalFile: working.originalFile } : {}),
    isFavorite: typeof working.isFavorite === "boolean" ? working.isFavorite : false,
    createdAt,
    lastModifiedAt: Number.isFinite(working.lastModifiedAt) ? working.lastModifiedAt : Date.now(),
    ...(latest ? { latestRunRef: latest.runRef } : {}),
    nextRunId: stagedRuns.length + 1,
    revision: 1,
  };
  await fs.writeFile(path.join(stagingDirectory, DESCRIPTOR_FILE_NAME), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  await verifyLineage(stagingDirectory, stagedRuns.length > 0);
  return { runCount: stagedRuns.length, latestRunRef: latest?.runRef };
}

async function removeIfEmpty(directory) {
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  }
}

async function removeMigratedLegacySources({ workingFile, historyDirectory, runnerLockFile }) {
  const cleanupFailures = [];
  const cleanup = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupFailures.push(`${label}: ${error.message}`);
    }
  };
  await cleanup("working file", () => fs.unlink(workingFile));
  if (historyDirectory) {
    await cleanup("history directory", () => fs.rm(historyDirectory, { recursive: true, force: false }));
  }
  await cleanup("stale runner lock", () => fs.unlink(runnerLockFile));
  return cleanupFailures;
}

async function migrate(options) {
  const ctrlyokeDirectory = path.join(options.workspaceRoot, ".ctrlyoke");
  const workingDirectory = path.join(ctrlyokeDirectory, ".working");
  const historyRoot = path.join(ctrlyokeDirectory, ".history");
  const runsRoot = path.join(ctrlyokeDirectory, ".runs");
  const quarantineRoot = path.join(ctrlyokeDirectory, ".migration-rejected");
  if (!(await exists(ctrlyokeDirectory))) throw new Error(`No .ctrlyoke directory found in ${options.workspaceRoot}`);

  const workingEntries = (await realDirectoryEntries(workingDirectory))
    .filter(({ entry }) => entry.isFile() && entry.name.endsWith(WORKING_FILE_SUFFIX));
  const historyEntries = (await realDirectoryEntries(historyRoot))
    .filter(({ entry }) => entry.isDirectory());
  const historyByLegacyId = new Map(historyEntries.map(({ entry, fullPath }) => [entry.name, fullPath]));
  const reservedKeys = new Set();
  const reports = [];

  if (workingEntries.length === 0 && historyEntries.length === 0) {
    console.log("No legacy .working or .history data found; nothing to migrate.");
    return;
  }

  for (const { entry, fullPath } of workingEntries) {
    const legacyId = entry.name.slice(0, -WORKING_FILE_SUFFIX.length);
    const baseWorkflowKey = workflowKeyFromLegacyId(legacyId);
    const baseDestination = path.join(runsRoot, baseWorkflowKey);
    const historyDirectory = historyByLegacyId.get(legacyId);
    historyByLegacyId.delete(legacyId);
    if (await exists(baseDestination)) {
      reports.push({
        status: "SKIP",
        legacyId,
        detail: `Destination already exists; legacy files were left untouched: ${baseDestination}`,
      });
      continue;
    }
    const workflowKey = await allocateWorkflowKey(runsRoot, legacyId, reservedKeys);
    const destination = path.join(runsRoot, workflowKey);
    if (!options.apply) {
      const runCount = (await realDirectoryEntries(historyDirectory)).filter(({ entry: history }) =>
        (history.isDirectory() && history.name.startsWith("run-")) ||
        (history.isFile() && /^run-.*\.json$/.test(history.name))
      ).length;
      reports.push({ status: "PLAN", legacyId, detail: `${workflowKey}: ${runCount || "draft"}` });
      continue;
    }

    const staging = path.join(runsRoot, `.migrating-${workflowKey}-${process.pid}-${Date.now()}`);
    try {
      await fs.mkdir(runsRoot, { recursive: true });
      await fs.mkdir(staging);
      const result = await buildLineage({ stagingDirectory: staging, workflowKey, workingFile: fullPath, historyDirectory });
      await fs.rename(staging, destination);
      const cleanupFailures = await removeMigratedLegacySources({
        workingFile: fullPath,
        historyDirectory,
        runnerLockFile: path.join(workingDirectory, `${legacyId}${RUNNER_LOCK_SUFFIX}`),
      });
      reports.push({
        status: cleanupFailures.length > 0 ? "WARN" : "OK",
        legacyId,
        detail: `${workflowKey}: ${result.runCount || "draft"}${result.latestRunRef ? `, latest ${result.latestRunRef}` : ""}${cleanupFailures.length > 0 ? `; new lineage created but legacy cleanup failed (${cleanupFailures.join("; ")})` : ""}`,
      });
    } catch (error) {
      reports.push({ status: "FAIL", legacyId, detail: error.message });
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  for (const [legacyId, historyDirectory] of historyByLegacyId) {
    const destination = path.join(quarantineRoot, `${workflowKeyFromLegacyId(legacyId)}-${Date.now()}`);
    if (!options.apply) {
      reports.push({ status: "QUARANTINE", legacyId, detail: `orphan history -> ${destination}` });
      continue;
    }
    try {
      await fs.mkdir(quarantineRoot, { recursive: true });
      await fs.rename(historyDirectory, destination);
      reports.push({ status: "QUARANTINED", legacyId, detail: destination });
    } catch (error) {
      reports.push({ status: "FAIL", legacyId, detail: `Could not quarantine orphan history: ${error.message}` });
    }
  }

  if (options.apply) {
    await removeIfEmpty(workingDirectory);
    await removeIfEmpty(historyRoot);
  }

  console.log(`\nctrlyoke legacy layout migration (${options.apply ? "APPLIED" : "DRY RUN"})`);
  for (const report of reports) console.log(`${report.status.padEnd(11)} ${report.legacyId} — ${report.detail}`);
  const failed = reports.filter((report) => report.status === "FAIL").length;
  const planned = reports.filter((report) => report.status === "PLAN").length;
  console.log(`\n${reports.length - failed} reported, ${failed} failed.${options.apply ? "" : ` Re-run with --apply to migrate ${planned} planned lineage(s).`}`);
  if (failed > 0) process.exitCode = 1;
}

const options = parseArguments(process.argv.slice(2));
migrate(options).catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
