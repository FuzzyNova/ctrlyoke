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
import { LineTooLongError, streamFileLines } from "../../utils/TextLines";

/**
 * Reads a run bundle (dev/backlog/RUN_EXPORT_PLAN.md §3) into memory, with its
 * `${workspaceFolder}` paths resolved onto the loading workspace.
 *
 * A bundle is untrusted input (§6): it is validated before anything uses it,
 * its size is capped, and nothing in it chooses a path outside the bundle.
 * The loader never reads `sourceRoot` to locate anything.
 */

/** Small JSON bundle files are materialized and parsed in one allocation. */
const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
/** A single JSONL event is bounded while the events file itself is streamed. */
export const MAX_EVENT_LINE_BYTES = 64 * 1024 * 1024;

export interface ReadRunBundleOptions {
  /** Override for tests that need to exercise the per-event limit cheaply. */
  maxEventLineBytes?: number;
  /** Override for tests exercising streaming past the former whole-file cap. */
  maxBundleFileBytes?: number;
}

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
  workspaceRoot: string,
  options: ReadRunBundleOptions = {}
): Promise<LoadedRunBundle> {
  const resolvedDir = path.resolve(bundleDir);
  const maxBundleFileBytes = options.maxBundleFileBytes;
  const manifest = (await readJson(
    resolvedDir,
    RUN_BUNDLE_FILES.BUNDLE,
    maxBundleFileBytes
  )) as Partial<RunBundleManifest> | undefined;
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
  const events = await readEvents(resolvedDir, load, options.maxEventLineBytes);

  return {
    bundleDir: resolvedDir,
    manifest: load<RunBundleManifest>(manifest),
    runManifest: load<RunBundleRunManifest>(
      await readJson(resolvedDir, RUN_BUNDLE_FILES.MANIFEST, maxBundleFileBytes)
    ),
    definition: load<Record<string, unknown>>(
      await readJson(
        resolvedDir,
        RUN_BUNDLE_FILES.DEFINITION,
        maxBundleFileBytes
      )
    ),
    events,
  };
}

async function readEvents(
  bundleDir: string,
  load: <T>(value: unknown) => T,
  maxEventLineBytes = MAX_EVENT_LINE_BYTES
): Promise<RunBundleEvent[]> {
  const fileName = RUN_BUNDLE_FILES.EVENTS;
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

  const events: RunBundleEvent[] = [];
  let lineNumber = 0;
  try {
    for await (const line of streamFileLines(filePath, {
      maxLineLength: maxEventLineBytes,
    })) {
      lineNumber++;
      if (Buffer.byteLength(line, "utf8") > maxEventLineBytes) {
        throw new RunBundleFormatError(
          `${fileName} line ${lineNumber} exceeds the ${maxEventLineBytes}-byte limit.`
        );
      }
      if (line.trim().length === 0) continue;
      try {
        events.push(load<RunBundleEvent>(JSON.parse(line)));
      } catch (error) {
        if (error instanceof RunBundleFormatError) throw error;
        throw new RunBundleFormatError(
          `${fileName} line ${lineNumber} is not valid JSON.`
        );
      }
    }
  } catch (error) {
    if (error instanceof RunBundleFormatError) throw error;
    if (error instanceof LineTooLongError) {
      throw new RunBundleFormatError(
        `${fileName} line ${error.lineNumber} exceeds the ${maxEventLineBytes}-byte limit.`
      );
    }
    throw error;
  }
  return events;
}

async function readText(
  bundleDir: string,
  fileName: string,
  maxBytes = MAX_BUNDLE_FILE_BYTES
): Promise<string> {
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
  if (stat.size > maxBytes) {
    throw new RunBundleFormatError(
      `${fileName} in ${bundleDir} is too large to load.`
    );
  }
  return fs.promises.readFile(filePath, "utf8");
}

async function readJson(
  bundleDir: string,
  fileName: string,
  maxBytes?: number
): Promise<unknown> {
  const text = await readText(bundleDir, fileName, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new RunBundleFormatError(
      `${fileName} in ${bundleDir} is not valid JSON.`
    );
  }
}
