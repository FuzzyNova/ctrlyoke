import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  RUN_BUNDLE_FILES,
  RUN_BUNDLE_KIND,
  RUN_BUNDLE_SCHEMA_VERSION,
  type RunBundleEvent,
  type RunBundleManifest,
  type RunBundleRunManifest,
  type RunBundleContinuation,
} from "../../types/RunBundleTypes";
import { TIMELINE_EVENT_TYPES } from "../../types/WorkflowTimelineTypes";
import {
  createWorkspacePathResolver,
  mapJsonStrings,
} from "../../utils/RunBundlePaths";
import { LineTooLongError, streamFileLines } from "../../utils/TextLines";
import { isPathWithinDirectory } from "../../utils/PathSecurity";

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
  maxTotalBytes?: number;
  maxEventCount?: number;
}

export interface RunBundleHeader {
  bundleDir: string;
  manifest: RunBundleManifest;
  runManifest: RunBundleRunManifest;
  definition: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  resolve: <T>(value: unknown) => T;
}

export interface LoadedRunBundle {
  bundleDir: string;
  manifest: RunBundleManifest;
  runManifest: RunBundleRunManifest;
  /** The authored workflow the run executed (`buildAuthoredWorkflow`). */
  definition: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  events: RunBundleEvent[];
}

export class RunBundleFormatError extends Error {}

export async function readRunBundle(
  bundleDir: string,
  workspaceRoot: string,
  options: ReadRunBundleOptions = {}
): Promise<LoadedRunBundle> {
  const header = await readRunBundleHeader(bundleDir, workspaceRoot, options);
  const events: RunBundleEvent[] = [];
  for await (const event of streamRunBundleEvents(header, options))
    events.push(event);
  return {
    bundleDir: header.bundleDir,
    manifest: header.manifest,
    runManifest: header.runManifest,
    definition: header.definition,
    ...(header.runtime ? { runtime: header.runtime } : {}),
    events,
  };
}

/** Validate bundle metadata and assets before an importer allocates any state. */
export async function readRunBundleHeader(
  bundleDir: string,
  workspaceRoot: string,
  options: ReadRunBundleOptions = {}
): Promise<RunBundleHeader> {
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
    !Number.isInteger(manifest.schemaVersion) ||
    manifest.schemaVersion < 1 ||
    manifest.schemaVersion > RUN_BUNDLE_SCHEMA_VERSION
  ) {
    throw new RunBundleFormatError(
      `${resolvedDir} was written by a newer ctrlyoke (bundle schema ${String(manifest.schemaVersion)}).`
    );
  }
  if (typeof manifest.sourceRoot !== "string") {
    throw new RunBundleFormatError("run.json contains an invalid sourceRoot.");
  }

  await validateAssets(resolvedDir, manifest.assets);

  const resolve = createWorkspacePathResolver(workspaceRoot);
  const load = <T>(value: unknown): T => mapJsonStrings(value, resolve) as T;
  const runManifest = load<RunBundleRunManifest>(
    await readJson(resolvedDir, RUN_BUNDLE_FILES.MANIFEST, maxBundleFileBytes)
  );
  if (
    !Number.isSafeInteger(runManifest.nextSequence) ||
    runManifest.nextSequence < 1 ||
    !Number.isFinite(runManifest.startedAt)
  ) {
    throw new RunBundleFormatError(
      "manifest.json contains invalid run metadata."
    );
  }
  const definition = load<Record<string, unknown>>(
    await readJson(resolvedDir, RUN_BUNDLE_FILES.DEFINITION, maxBundleFileBytes)
  );
  const runtime = await readOptionalJson(
    resolvedDir,
    RUN_BUNDLE_FILES.RUNTIME,
    maxBundleFileBytes
  );
  const continuation = manifest.continuation as
    RunBundleContinuation | undefined;
  if (
    continuation !== undefined &&
    (!continuation ||
      typeof continuation !== "object" ||
      !continuation.workspace ||
      typeof continuation.workspace !== "object")
  ) {
    throw new RunBundleFormatError(
      "run.json contains invalid continuation metadata."
    );
  }
  if (continuation?.workspace.patch) {
    if (
      continuation.workspace.patch.file !== RUN_BUNDLE_FILES.CHANGES ||
      typeof continuation.workspace.patch.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(continuation.workspace.patch.sha256)
    ) {
      throw new RunBundleFormatError(
        "run.json contains an invalid patch file."
      );
    }
    const patch = await readText(
      resolvedDir,
      continuation.workspace.patch.file,
      maxBundleFileBytes
    );
    const digest = crypto.createHash("sha256").update(patch).digest("hex");
    if (digest !== continuation.workspace.patch.sha256) {
      throw new RunBundleFormatError(
        `${continuation.workspace.patch.file} failed its SHA-256 check.`
      );
    }
  }
  const resolvedManifest = load<RunBundleManifest>(manifest);
  // sourceRoot is provenance, not an input path. Preserve the exporter's value
  // instead of resolving its workspace token onto the importing workspace.
  resolvedManifest.sourceRoot = manifest.sourceRoot;
  // The ancestry chain is also provenance; keep its portable roots intact.
  resolvedManifest.importedFrom = manifest.importedFrom;
  const files = [
    RUN_BUNDLE_FILES.BUNDLE,
    RUN_BUNDLE_FILES.MANIFEST,
    RUN_BUNDLE_FILES.DEFINITION,
  ];
  let totalBytes = 0;
  for (const name of files)
    totalBytes += (await fs.promises.stat(path.join(resolvedDir, name))).size;
  const eventsStat = await safeEventStat(resolvedDir);
  totalBytes +=
    eventsStat.size +
    (runtime === undefined
      ? 0
      : (
          await fs.promises.stat(
            path.join(resolvedDir, RUN_BUNDLE_FILES.RUNTIME)
          )
        ).size) +
    (continuation?.workspace.patch
      ? (
          await fs.promises.stat(
            path.join(resolvedDir, RUN_BUNDLE_FILES.CHANGES)
          )
        ).size
      : 0) +
    (manifest.assets ?? []).reduce((sum, asset) => sum + asset.bytes, 0);
  if (totalBytes > (options.maxTotalBytes ?? 512 * 1024 * 1024)) {
    throw new RunBundleFormatError("Run bundle exceeds the total size limit.");
  }
  return {
    bundleDir: resolvedDir,
    manifest: resolvedManifest,
    runManifest,
    definition,
    ...(runtime !== undefined
      ? { runtime: load<Record<string, unknown>>(runtime) }
      : {}),
    resolve: <T>(value: unknown): T => mapJsonStrings(value, resolve) as T,
  };
}

/** Stream validated JSONL events, enforcing line and total event caps. */
export async function* streamRunBundleEvents(
  header: RunBundleHeader,
  options: ReadRunBundleOptions = {}
): AsyncGenerator<RunBundleEvent, void, undefined> {
  for await (const event of readEvents(
    header.bundleDir,
    <T>(value: unknown) => header.resolve<T>(value),
    options.maxEventLineBytes,
    options.maxEventCount
  )) {
    yield event;
  }
}

async function safeEventStat(bundleDir: string): Promise<fs.Stats> {
  const filePath = path.join(bundleDir, RUN_BUNDLE_FILES.EVENTS);
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return stat;
  } catch {
    throw new RunBundleFormatError(
      `${bundleDir} has no ${RUN_BUNDLE_FILES.EVENTS}.`
    );
  }
}

async function validateAssets(
  bundleDir: string,
  assets: RunBundleManifest["assets"]
): Promise<void> {
  if (assets === undefined) return;
  if (!Array.isArray(assets)) {
    throw new RunBundleFormatError("run.json assets must be an array.");
  }
  const bundleRealPath = await fs.promises.realpath(bundleDir);
  for (const asset of assets) {
    if (
      !asset ||
      typeof asset.path !== "string" ||
      !asset.path ||
      path.isAbsolute(asset.path) ||
      path.posix.isAbsolute(asset.path) ||
      asset.path.includes("\\") ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0
    ) {
      throw new RunBundleFormatError(
        "run.json contains an invalid asset record."
      );
    }
    const filePath = path.resolve(bundleDir, asset.path);
    if (!isPathWithinDirectory(filePath, bundleDir)) {
      throw new RunBundleFormatError(
        `Bundle asset path "${asset.path}" escapes the bundle directory.`
      );
    }
    let stats: fs.Stats;
    let realPath: string;
    try {
      [stats, realPath] = await Promise.all([
        fs.promises.lstat(filePath),
        fs.promises.realpath(filePath),
      ]);
    } catch {
      throw new RunBundleFormatError(
        `Bundle asset "${asset.path}" is missing or unreadable.`
      );
    }
    if (!stats.isFile() || !isPathWithinDirectory(realPath, bundleRealPath)) {
      throw new RunBundleFormatError(
        `Bundle asset "${asset.path}" is not a regular file inside the bundle.`
      );
    }
    if (stats.size !== asset.bytes) {
      throw new RunBundleFormatError(
        `Bundle asset "${asset.path}" failed its size check.`
      );
    }
    const hash = crypto.createHash("sha256");
    try {
      for await (const chunk of fs.createReadStream(filePath))
        hash.update(chunk);
    } catch {
      throw new RunBundleFormatError(
        `Bundle asset "${asset.path}" is missing or unreadable.`
      );
    }
    if (hash.digest("hex") !== asset.sha256) {
      throw new RunBundleFormatError(
        `Bundle asset "${asset.path}" failed its SHA-256 check.`
      );
    }
  }
}

async function* readEvents(
  bundleDir: string,
  load: <T>(value: unknown) => T,
  maxEventLineBytes = MAX_EVENT_LINE_BYTES,
  maxEventCount = 1_000_000
): AsyncGenerator<RunBundleEvent, void, undefined> {
  const fileName = RUN_BUNDLE_FILES.EVENTS;
  const filePath = path.join(bundleDir, fileName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    throw new RunBundleFormatError(`${bundleDir} has no ${fileName}.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RunBundleFormatError(
      `${fileName} in ${bundleDir} is not a regular file.`
    );
  }

  let lineNumber = 0;
  let eventCount = 0;
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
      if (eventCount >= maxEventCount) {
        throw new RunBundleFormatError(
          `events.jsonl exceeds the ${maxEventCount}-event limit.`
        );
      }
      let event: RunBundleEvent;
      try {
        event = load<RunBundleEvent>(JSON.parse(line));
      } catch (error) {
        if (error instanceof RunBundleFormatError) throw error;
        throw new RunBundleFormatError(
          `${fileName} line ${lineNumber} is not valid JSON.`
        );
      }
      if (
        !event ||
        typeof event !== "object" ||
        !Object.values(TIMELINE_EVENT_TYPES).includes(event.eventType)
      ) {
        throw new RunBundleFormatError(
          `${fileName} line ${lineNumber} is not a recognized timeline event.`
        );
      }
      eventCount++;
      yield event;
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
  if (!stat.isFile() || stat.isSymbolicLink()) {
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

async function readOptionalJson(
  bundleDir: string,
  fileName: string,
  maxBytes?: number
): Promise<unknown | undefined> {
  try {
    await fs.promises.lstat(path.join(bundleDir, fileName));
  } catch {
    return undefined;
  }
  return readJson(bundleDir, fileName, maxBytes);
}
