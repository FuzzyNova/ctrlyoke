import * as fs from "fs/promises";
import * as path from "path";
import { pathsEqual, foldPathForCompare } from "./PathCasing";
import { isPathWithinDirectory } from "./PathSecurity";
import { getGitIgnoredPaths } from "./GitUtils";

/**
 * Find references that exist only in the source checkout as ignored artifacts.
 *
 * The returned map preserves each candidate reference as its key and stores
 * the absolute source-side path that may be read by ctrlyoke. A missing or
 * non-worktree source root deliberately returns an empty map without any
 * filesystem or Git work.
 */
export async function resolveSourceRuntimeArtifacts(
  sourceCheckoutRoot: string | undefined,
  executionCheckoutRoot: string,
  candidateReferencePaths: ReadonlySet<string>
): Promise<Map<string, string>> {
  if (
    sourceCheckoutRoot === undefined ||
    pathsEqual(
      path.resolve(sourceCheckoutRoot),
      path.resolve(executionCheckoutRoot)
    )
  ) {
    return new Map<string, string>();
  }

  const sourceRoot = path.resolve(sourceCheckoutRoot);
  const executionRoot = path.resolve(executionCheckoutRoot);
  const resolvedCandidates = Array.from(
    candidateReferencePaths,
    (referencePath) => ({
      referencePath,
      executionPath: resolveCandidatePath(executionRoot, referencePath),
      sourcePath: resolveCandidatePath(sourceRoot, referencePath),
    })
  );

  const executionMisses = await Promise.all(
    resolvedCandidates.map(async (candidate) => ({
      candidate,
      existsInExecution:
        isPathWithinDirectory(candidate.executionPath, executionRoot) &&
        (await pathExists(candidate.executionPath)),
    }))
  );
  const sourceCandidates = executionMisses
    .filter(({ existsInExecution }) => !existsInExecution)
    .map(({ candidate }) => candidate);
  if (sourceCandidates.length === 0) {
    return new Map<string, string>();
  }

  const realSourceRoot = await realpathOrUndefined(sourceRoot);
  const realExecutionRoot = await realpathOrUndefined(executionRoot);
  if (realSourceRoot === undefined || realExecutionRoot === undefined) {
    return new Map<string, string>();
  }

  const existingSourceArtifacts = await Promise.all(
    sourceCandidates.map(async (candidate) => ({
      candidate,
      exists: await pathExists(candidate.sourcePath),
    }))
  );
  const existingArtifacts = existingSourceArtifacts
    .filter(({ exists }) => exists)
    .map(({ candidate }) => candidate);
  const containedSourceArtifacts = await Promise.all(
    existingArtifacts.map(async (candidate) => ({
      candidate,
      realSourcePath: await realpathOrUndefined(candidate.sourcePath),
    }))
  );
  const safeSourceArtifacts = containedSourceArtifacts.filter(
    ({ realSourcePath }) =>
      realSourcePath !== undefined &&
      isPathWithinDirectory(realSourcePath, realSourceRoot)
  );
  if (safeSourceArtifacts.length === 0) {
    return new Map<string, string>();
  }

  const ignoredPaths = await getGitIgnoredPaths(
    sourceRoot,
    safeSourceArtifacts.map(({ candidate }) => candidate.sourcePath)
  );
  const ignoredPathKeys = new Set(
    Array.from(ignoredPaths, (ignoredPath) => foldPathForCompare(ignoredPath))
  );

  return new Map(
    safeSourceArtifacts
      .filter(({ candidate }) =>
        ignoredPathKeys.has(foldPathForCompare(candidate.sourcePath))
      )
      .map(({ candidate }) => [candidate.referencePath, candidate.sourcePath])
  );
}

function resolveCandidatePath(root: string, referencePath: string): string {
  return path.isAbsolute(referencePath)
    ? path.normalize(referencePath)
    : path.resolve(root, referencePath);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrUndefined(
  candidatePath: string
): Promise<string | undefined> {
  try {
    return await fs.realpath(candidatePath);
  } catch {
    return undefined;
  }
}
