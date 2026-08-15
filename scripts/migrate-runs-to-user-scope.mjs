import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CTRLYOKE_DIRECTORY = ".ctrlyoke";
const PROJECTS_DIRECTORY = "projects";
const PROJECT_METADATA_FILE = "project.json";
const RUNS_DIRECTORY = ".runs";
const SEARCH_INDEX_DIRECTORY = ".search-index";
const USAGE_DIRECTORY = ".usage";
const OBSERVED_USAGE_FILE = "observed-usage.json";
const LIFETIME_STATS_FILE = "lifetime-stats.json";
const PROJECT_SCHEMA_VERSION = 1;
const PROJECT_SLUG_MAX_LENGTH = 48;
const PROJECT_HASH_LENGTH = 12;

function parseArguments(args) {
  const options = {
    stateRoot: process.cwd(),
    apply: false,
    printKey: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--print-key") {
      options.printKey = true;
    } else if (argument === "--state-root") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--state-root requires a path");
      }
      options.stateRoot = value;
      index += 1;
    } else if (argument.startsWith("--state-root=")) {
      const value = argument.slice("--state-root=".length);
      if (!value) throw new Error("--state-root requires a path");
      options.stateRoot = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function foldPathForCompare(value) {
  // Keep this split identical to src/utils/PathCasing.ts. macOS and Linux
  // intentionally preserve case; only Windows filesystems fold it.
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function projectKey(stateRoot) {
  const resolvedStateRoot = path.resolve(stateRoot);
  const slug = sanitizeProjectSlug(path.basename(resolvedStateRoot));
  const hash = createHash("sha256")
    .update(foldPathForCompare(resolvedStateRoot))
    .digest("hex")
    .slice(0, PROJECT_HASH_LENGTH);
  return `${slug}-${hash}`;
}

function sanitizeProjectSlug(basename) {
  const ascii = basename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  const sanitized = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return sanitized || "project";
}

function stateHome() {
  const override = process.env.CTRLYOKE_HOME;
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), CTRLYOKE_DIRECTORY);
}

function pathsEqual(left, right) {
  return foldPathForCompare(left) === foldPathForCompare(right);
}

async function lstatIfExists(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(filePath) {
  return (await lstatIfExists(filePath)) !== undefined;
}

async function readDirectory(directory) {
  return fs.readdir(directory, { withFileTypes: true });
}

async function assertNoLiveRunnerLocks(root) {
  if (!(await exists(root))) return;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readDirectory(directory)) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "runner.json") continue;

      let lock;
      try {
        lock = JSON.parse(await fs.readFile(entryPath, "utf8"));
      } catch (error) {
        throw new Error(
          `Could not inspect runner lock ${entryPath}: ${error.message}`
        );
      }
      if (
        typeof lock?.pid === "number" &&
        Number.isInteger(lock.pid) &&
        lock.pid > 0 &&
        isProcessAlive(lock.pid)
      ) {
        throw new Error(`Live runner PID ${lock.pid} found in ${entryPath}`);
      }
    }
  }
}

async function assertNoSymlinks(root) {
  const stats = await lstatIfExists(root);
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to migrate symlink: ${root}`);
  }
  if (!stats.isDirectory()) return;
  for (const entry of await readDirectory(root)) {
    await assertNoSymlinks(path.join(root, entry.name));
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function validateProjectMetadata(metadataPath, stateRoot) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid project metadata JSON at ${metadataPath}: ${error.message}`
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid project metadata at ${metadataPath}`);
  }
  if (value.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Project metadata schema ${value.schemaVersion} is newer than supported schema ${PROJECT_SCHEMA_VERSION}: ${metadataPath}`
    );
  }
  if (
    value.schemaVersion !== PROJECT_SCHEMA_VERSION ||
    typeof value.statePath !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.lastOpenedAt !== "string" ||
    (value.gitToplevel !== undefined && typeof value.gitToplevel !== "string")
  ) {
    throw new Error(`Invalid project metadata fields at ${metadataPath}`);
  }
  if (!pathsEqual(path.resolve(value.statePath), stateRoot)) {
    throw new Error(
      `Project state collision: ${path.dirname(metadataPath)} belongs to "${value.statePath}", not "${stateRoot}"`
    );
  }
}

async function assertEmptyDirectory(directory, label) {
  const stats = await lstatIfExists(directory);
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} is not an ordinary directory: ${directory}`);
  }
  const entries = await readDirectory(directory);
  if (entries.length > 0) {
    throw new Error(
      `Destination conflict: ${label} is not empty: ${directory}`
    );
  }
  return true;
}

async function inspectDestination(destination, stateRoot) {
  const stats = await lstatIfExists(destination);
  if (!stats) return { exists: false };
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Destination project is not an ordinary directory: ${destination}`
    );
  }

  const metadataPath = path.join(destination, PROJECT_METADATA_FILE);
  const metadataStats = await lstatIfExists(metadataPath);
  if (
    metadataStats?.isSymbolicLink() ||
    (metadataStats && !metadataStats.isFile())
  ) {
    throw new Error(
      `Project metadata is not an ordinary file: ${metadataPath}`
    );
  }
  if (metadataStats) {
    await validateProjectMetadata(metadataPath, stateRoot);
  } else if ((await readDirectory(destination)).length > 0) {
    throw new Error(
      `Project state directory is non-empty but has no project metadata: ${destination}`
    );
  }

  for (const [directory, label] of [
    [RUNS_DIRECTORY, "destination .runs"],
    [SEARCH_INDEX_DIRECTORY, "destination .search-index"],
    [USAGE_DIRECTORY, "destination .usage"],
  ]) {
    await assertEmptyDirectory(path.join(destination, directory), label);
  }

  const allowed = new Set([
    PROJECT_METADATA_FILE,
    RUNS_DIRECTORY,
    SEARCH_INDEX_DIRECTORY,
    USAGE_DIRECTORY,
  ]);
  for (const entry of await readDirectory(destination)) {
    if (!allowed.has(entry.name)) {
      throw new Error(
        `Destination conflict: unexpected entry ${path.join(destination, entry.name)}`
      );
    }
  }
  return { exists: true };
}

async function assertContainedByProjectsRoot(projectsRoot, destination) {
  const realRoot = await fs.realpath(projectsRoot);
  const relative = path.relative(realRoot, path.resolve(destination));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Destination escapes the projects root: ${destination}`);
  }
}

async function writeProjectMetadata(destination, stateRoot) {
  const metadataPath = path.join(destination, PROJECT_METADATA_FILE);
  const now = new Date().toISOString();
  const contents = `${JSON.stringify(
    {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      statePath: stateRoot,
      createdAt: now,
      lastOpenedAt: now,
    },
    null,
    2
  )}\n`;
  const temporaryPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, metadataPath);
    await fs.chmod(metadataPath, 0o600);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function prepareDestination(destination, stateRoot) {
  const projectsRoot = path.dirname(destination);
  await fs.mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(projectsRoot, 0o700);
  await assertContainedByProjectsRoot(projectsRoot, destination);

  const destinationStats = await lstatIfExists(destination);
  if (!destinationStats) {
    await fs.mkdir(destination, { mode: 0o700 });
    await writeProjectMetadata(destination, stateRoot);
    return;
  }
  if (destinationStats.isSymbolicLink() || !destinationStats.isDirectory()) {
    throw new Error(`Destination project is not an ordinary directory: ${destination}`);
  }

  await fs.chmod(destination, 0o700);
  const metadataPath = path.join(destination, PROJECT_METADATA_FILE);
  if (!(await exists(metadataPath))) {
    await writeProjectMetadata(destination, stateRoot);
  }
  for (const directory of [
    RUNS_DIRECTORY,
    SEARCH_INDEX_DIRECTORY,
    USAGE_DIRECTORY,
  ]) {
    const directoryPath = path.join(destination, directory);
    if (await assertEmptyDirectory(directoryPath, `destination ${directory}`)) {
      await fs.rmdir(directoryPath);
    }
  }
  await assertContainedByProjectsRoot(projectsRoot, destination);
}

async function copyEntry(source, destination) {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to migrate symlink: ${source}`);
  }
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { mode: 0o700 });
    for (const entry of await readDirectory(source)) {
      await copyEntry(
        path.join(source, entry.name),
        path.join(destination, entry.name)
      );
    }
    return;
  }
  if (!stats.isFile()) throw new Error(`Unsupported source entry: ${source}`);
  await fs.copyFile(source, destination);
  const handle = await fs.open(destination, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!["EISDIR", "EPERM", "EINVAL"].includes(error?.code)) throw error;
  }
}

async function moveEntry(source, destination, projectsRoot) {
  const forcedExdev = process.env.CTRLYOKE_MIGRATION_TEST_FORCE_EXDEV === "1";
  try {
    if (forcedExdev) {
      const error = new Error("forced cross-device rename for test");
      error.code = "EXDEV";
      throw error;
    }
    await assertContainedByProjectsRoot(projectsRoot, destination);
    await fs.rename(source, destination);
    return "rename";
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }

  const staging = path.join(
    path.dirname(destination),
    `.migrating-${path.basename(destination)}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const stagedEntry = path.join(staging, path.basename(destination));
  try {
    await fs.mkdir(staging, { mode: 0o700 });
    await copyEntry(source, stagedEntry);
    await syncDirectory(staging);
    await assertContainedByProjectsRoot(projectsRoot, destination);
    await fs.rename(stagedEntry, destination);
    await syncDirectory(path.dirname(destination));
    await removeSource(source);
    await fs.rmdir(staging);
    return "EXDEV fallback";
  } catch (error) {
    await fs
      .rm(staging, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
}

async function removeSource(source) {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink())
    throw new Error(`Refusing to remove symlink: ${source}`);
  await fs.rm(source, { recursive: stats.isDirectory(), force: false });
}

async function sourceArtifact(source, name) {
  const filePath = path.join(source, name);
  const stats = await lstatIfExists(filePath);
  if (!stats) return undefined;
  if (stats.isSymbolicLink())
    throw new Error(`Refusing to migrate symlink: ${filePath}`);
  return { path: filePath, stats };
}

async function listUnknownUsageFiles(usageRoot) {
  const stats = await lstatIfExists(usageRoot);
  if (!stats) return [];
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Source .usage is not an ordinary directory: ${usageRoot}`);
  }
  return (await readDirectory(usageRoot))
    .filter(
      (entry) =>
        ![OBSERVED_USAGE_FILE, LIFETIME_STATS_FILE].includes(entry.name)
    )
    .map((entry) => path.join(usageRoot, entry.name));
}

async function removeEmptyUsageDirectory(usageRoot) {
  try {
    await fs.rmdir(usageRoot);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
  }
}

async function migrate(options) {
  const resolvedStateRoot = path.resolve(options.stateRoot);
  const key = projectKey(resolvedStateRoot);
  const destination = path.join(stateHome(), PROJECTS_DIRECTORY, key);
  console.log(`Resolved state root: ${resolvedStateRoot}`);
  console.log(`Project key: ${key}`);
  console.log(`Destination: ${destination}`);

  if (options.printKey) return;

  const sourceCtrlyoke = path.join(resolvedStateRoot, CTRLYOKE_DIRECTORY);
  if (!(await exists(sourceCtrlyoke))) {
    throw new Error(`No .ctrlyoke directory found in ${resolvedStateRoot}`);
  }

  await assertNoLiveRunnerLocks(sourceCtrlyoke);

  const sourceRuns = await sourceArtifact(sourceCtrlyoke, RUNS_DIRECTORY);
  if (sourceRuns && !sourceRuns.stats.isDirectory()) {
    throw new Error(
      `Source .runs is not an ordinary directory: ${sourceRuns.path}`
    );
  }
  const sourceRunsEntries = sourceRuns
    ? await readDirectory(sourceRuns.path)
    : [];
  if (sourceRuns) await assertNoSymlinks(sourceRuns.path);
  const sourceUsage = path.join(sourceCtrlyoke, USAGE_DIRECTORY);
  const observed = await sourceArtifact(sourceUsage, OBSERVED_USAGE_FILE);
  if (observed && !observed.stats.isFile()) {
    throw new Error(`Observed usage is not a regular file: ${observed.path}`);
  }
  const lifetime = await sourceArtifact(sourceUsage, LIFETIME_STATS_FILE);
  if (lifetime && !lifetime.stats.isFile()) {
    throw new Error(`Lifetime stats is not a regular file: ${lifetime.path}`);
  }
  const unknownUsage = await listUnknownUsageFiles(sourceUsage);

  if (sourceRunsEntries.length === 0 && !observed) {
    console.log("No .runs or observed usage data found; nothing to migrate.");
    for (const unknown of unknownUsage)
      console.log(`UNTOUCHED unknown source usage: ${unknown}`);
    return;
  }

  await inspectDestination(destination, resolvedStateRoot);
  const destinationRuns = path.join(destination, RUNS_DIRECTORY);
  const destinationObserved = path.join(
    destination,
    USAGE_DIRECTORY,
    OBSERVED_USAGE_FILE
  );
  const plans = [];
  if (sourceRunsEntries.length > 0) {
    plans.push({
      source: sourceRuns.path,
      destination: destinationRuns,
      label: ".runs",
    });
  }
  if (observed) {
    plans.push({
      source: observed.path,
      destination: destinationObserved,
      label: "observed usage",
    });
  }

  console.log(
    `\nctrlyoke user-scope migration (${options.apply ? "APPLY" : "DRY RUN"})`
  );
  for (const plan of plans) {
    console.log(
      `${options.apply ? "MOVE" : "PLAN"} ${plan.label}: ${plan.source} -> ${plan.destination}`
    );
  }
  if (lifetime)
    console.log(
      `${options.apply ? "DELETE" : "PLAN DELETE"} lifetime stats: ${lifetime.path}`
    );
  const sourceSearchIndex = path.join(sourceCtrlyoke, SEARCH_INDEX_DIRECTORY);
  if (await exists(sourceSearchIndex)) {
    const stats = await fs.lstat(sourceSearchIndex);
    if (stats.isSymbolicLink())
      throw new Error(`Refusing to remove symlink: ${sourceSearchIndex}`);
    if (!stats.isDirectory())
      throw new Error(
        `Source search index is not a directory: ${sourceSearchIndex}`
      );
    console.log(
      `${options.apply ? "DELETE" : "PLAN DELETE"} search index: ${sourceSearchIndex}`
    );
  }
  for (const unknown of unknownUsage)
    console.log(`UNTOUCHED unknown source usage: ${unknown}`);

  if (!options.apply) {
    console.log(`\nRe-run with --apply to migrate ${plans.length} item(s).`);
    return;
  }

  await prepareDestination(destination, resolvedStateRoot);
  const projectsRoot = path.dirname(destination);
  for (const plan of plans) {
    if (plan.label === "observed usage") {
      await fs.mkdir(path.dirname(plan.destination), {
        recursive: true,
        mode: 0o700,
      });
    }
    const method = await moveEntry(plan.source, plan.destination, projectsRoot);
    console.log(`OK ${plan.label} (${method})`);
  }

  if (lifetime) await removeSource(lifetime.path);
  if (await exists(sourceSearchIndex)) await removeSource(sourceSearchIndex);
  await removeEmptyUsageDirectory(sourceUsage);
  console.log(
    "Migration applied; source run history and retained observed usage were moved."
  );
}

const options = parseArguments(process.argv.slice(2));
migrate(options).catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
