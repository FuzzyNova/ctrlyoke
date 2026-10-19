import * as fs from "fs";
import * as path from "path";
import {
  RUN_BUNDLE_FILES,
  RUN_BUNDLE_KIND,
  RUN_BUNDLE_SCHEMA_VERSION,
  type RunBundleEvent,
  type RunBundleManifest,
  type RunBundleRunManifest,
} from "../../types/RunBundleTypes";
import {
  createWorkspacePathResolver,
  mapJsonStrings,
} from "../../utils/RunBundlePaths";
import { splitLines } from "../../utils/TextLines";

/**
 * Reads a run bundle (dev/backlog/RUN_EXPORT_PLAN.md §3) into memory, with its
 * `${workspaceFolder}` paths resolved onto the loading workspace.
 *
 * A bundle is untrusted input (§6): it is validated before anything uses it,
 * its size is capped, and nothing in it chooses a path outside the bundle.
 * The loader never reads `sourceRoot` to locate anything.
 */

/** Generous for a run (the hero fixture is under 1 MB) while bounding memory. */
const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;

export interface LoadedRunBundle {
  bundleDir: string;
  manifest: RunBundleManifest;
  runManifest: RunBundleRunManifest;
  /** The authored workflow the run executed (`buildAuthoredWorkflow`). */
  definition: Record<string, unknown>;
  events: RunBundleEvent[];
}

export class RunBundleFormatError extends Error {}

export async function readRunBundle(
  bundleDir: string,
  workspaceRoot: string
): Promise<LoadedRunBundle> {
  const resolvedDir = path.resolve(bundleDir);
  const manifest = (await readJson(resolvedDir, RUN_BUNDLE_FILES.BUNDLE)) as
    Partial<RunBundleManifest> | undefined;
  if (manifest?.kind !== RUN_BUNDLE_KIND) {
    throw new RunBundleFormatError(
      `${resolvedDir} is not a ctrlyoke run bundle.`
    );
  }
  if (
    typeof manifest.schemaVersion !== "number" ||
    manifest.schemaVersion > RUN_BUNDLE_SCHEMA_VERSION
  ) {
    throw new RunBundleFormatError(
      `${resolvedDir} was written by a newer ctrlyoke (bundle schema ${String(manifest.schemaVersion)}).`
    );
  }

  const resolve = createWorkspacePathResolver(workspaceRoot);
  const load = <T>(value: unknown): T => mapJsonStrings(value, resolve) as T;
  const eventsText = await readText(resolvedDir, RUN_BUNDLE_FILES.EVENTS);
  const events = splitLines(eventsText)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return load<RunBundleEvent>(JSON.parse(line));
      } catch {
        throw new RunBundleFormatError(
          `${RUN_BUNDLE_FILES.EVENTS} line ${index + 1} is not valid JSON.`
        );
      }
    });

  return {
    bundleDir: resolvedDir,
    manifest: load<RunBundleManifest>(manifest),
    runManifest: load<RunBundleRunManifest>(
      await readJson(resolvedDir, RUN_BUNDLE_FILES.MANIFEST)
    ),
    definition: load<Record<string, unknown>>(
      await readJson(resolvedDir, RUN_BUNDLE_FILES.DEFINITION)
    ),
    events,
  };
}

async function readText(bundleDir: string, fileName: string): Promise<string> {
  const filePath = path.join(bundleDir, fileName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    throw new RunBundleFormatError(`${bundleDir} has no ${fileName}.`);
  }
  if (!stat.isFile()) {
    throw new RunBundleFormatError(
      `${fileName} in ${bundleDir} is not a regular file.`
    );
  }
  if (stat.size > MAX_BUNDLE_FILE_BYTES) {
    throw new RunBundleFormatError(
      `${fileName} in ${bundleDir} is too large to load.`
    );
  }
  return fs.promises.readFile(filePath, "utf8");
}

async function readJson(bundleDir: string, fileName: string): Promise<unknown> {
  const text = await readText(bundleDir, fileName);
  try {
    return JSON.parse(text);
  } catch {
    throw new RunBundleFormatError(
      `${fileName} in ${bundleDir} is not valid JSON.`
    );
  }
}
