import * as fs from "fs/promises";
import * as path from "path";
import {
  BUNDLE_MANIFEST_FILE_NAME,
  BUNDLE_MANIFEST_VERSION,
  type BundlePlan,
} from "./WorkflowBundleAnalyzer";
import { renameWithTransientRetry, writeFileAtomic } from "./AtomicFileUtils";
import { foldPathForCompare } from "./PathCasing";

export interface WorkflowBundleWriteOptions {
  workflowPath: string;
  serializedWorkflow: string;
  plan: BundlePlan;
}

export interface WorkflowBundleWriteResult {
  warnings: string[];
}

/**
 * Publish the write-side of a Save As bundle.
 *
 * The analyzer owns discovery, naming, rewriting, and prune candidates. This
 * function only consumes that plan and preserves the required commit order:
 * stage/verify copies, publish assets, publish the workflow, publish the
 * manifest, then prune old managed files.
 */
export async function writeWorkflowBundle(
  options: WorkflowBundleWriteOptions
): Promise<WorkflowBundleWriteResult> {
  const { workflowPath, serializedWorkflow, plan } = options;
  const warnings: string[] = [
    ...plan.warnings.map((warning) => warning.message),
  ];
  const assetsDirectory = plan.assetsDirectory;
  const copies = plan.copies;
  let stagingDirectory: string | undefined;
  const stagedPaths = new Map<BundlePlan["copies"][number], string>();

  try {
    if (copies.length > 0) {
      if (!assetsDirectory) {
        throw new Error("Bundle analysis did not provide an assets directory.");
      }
      await fs.mkdir(assetsDirectory, { recursive: true });
      await assertDirectory(assetsDirectory);
      stagingDirectory = await fs.mkdtemp(
        path.join(assetsDirectory, ".ctrlyoke-staging-")
      );

      for (const [index, copy] of copies.entries()) {
        const fileName = getAssetFileName(
          copy.destinationPath,
          assetsDirectory
        );
        const stagedPath = path.join(stagingDirectory, `${index}-${fileName}`);
        const sourceBytes = await fs.readFile(copy.sourcePath);
        await fs.writeFile(stagedPath, sourceBytes);
        const stagedBytes = await fs.readFile(stagedPath);
        if (!sourceBytes.equals(stagedBytes)) {
          throw new Error(
            `Staged asset verification failed for "${copy.sourcePath}".`
          );
        }
        stagedPaths.set(copy, stagedPath);
      }

      // Each staged file is a temporary file. Renaming it publishes a complete
      // asset without exposing a partially written destination.
      for (const copy of copies) {
        const stagedPath = stagedPaths.get(copy);
        if (!stagedPath) {
          throw new Error(`Missing staged asset for "${copy.sourcePath}".`);
        }
        await renameWithTransientRetry(stagedPath, copy.destinationPath);
      }
    }

    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFileAtomic(workflowPath, serializedWorkflow);

    if (assetsDirectory) {
      const manifestPath = path.join(
        assetsDirectory,
        BUNDLE_MANIFEST_FILE_NAME
      );
      if (copies.length > 0) {
        await fs.mkdir(assetsDirectory, { recursive: true });
        const files = copies.map((copy) =>
          path
            .relative(assetsDirectory, copy.destinationPath)
            .replace(/\\/g, "/")
        );
        try {
          await writeFileAtomic(
            manifestPath,
            JSON.stringify(
              { version: BUNDLE_MANIFEST_VERSION, files },
              null,
              2
            ) + "\n"
          );
        } catch (error) {
          warnings.push(
            `Could not update bundle manifest "${manifestPath}": ${getErrorMessage(error)}. Existing and new assets were left in place.`
          );
        }
      }

      await pruneManagedAssets(
        assetsDirectory,
        plan.pruneCandidates,
        serializedWorkflow,
        copies.map((copy) => copy.destinationPath),
        warnings
      );

      const hasInvalidManifest = plan.warnings.some(
        (warning) => warning.code === "invalid-assets-manifest"
      );
      if (copies.length === 0 && !hasInvalidManifest) {
        try {
          await fs.unlink(manifestPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
            warnings.push(
              `Could not remove obsolete bundle manifest "${manifestPath}": ${getErrorMessage(error)}.`
            );
          }
        }
        await removeDirectoryWhenEmpty(assetsDirectory, warnings);
      }
    }
  } finally {
    if (stagingDirectory) {
      await fs
        .rm(stagingDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
  }

  return { warnings };
}

function getAssetFileName(
  destinationPath: string,
  assetsDirectory: string
): string {
  const relative = path.relative(assetsDirectory, destinationPath);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.dirname(relative) !== "."
  ) {
    throw new Error(`Bundle asset destination escapes "${assetsDirectory}".`);
  }
  return relative;
}

async function assertDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Bundle assets path "${directory}" is not a real directory.`
    );
  }
}

async function pruneManagedAssets(
  assetsDirectory: string,
  candidates: readonly string[],
  serializedWorkflow: string,
  publishedPaths: readonly string[],
  warnings: string[]
): Promise<void> {
  for (const relativePath of candidates) {
    if (isSerializedReference(serializedWorkflow, relativePath)) {
      continue;
    }
    const target = path.resolve(assetsDirectory, relativePath);
    if (!isContainedPath(target, assetsDirectory)) {
      warnings.push(
        `Skipped unsafe managed asset prune path "${relativePath}".`
      );
      continue;
    }
    try {
      if (!(await hasSymlinkAncestor(target, assetsDirectory))) {
        const stats = await fs.lstat(target);
        if (
          stats.isFile() &&
          !(await resolvesToPublishedFile(target, publishedPaths, stats))
        ) {
          await fs.unlink(target);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        warnings.push(
          `Could not prune managed asset "${target}": ${getErrorMessage(error)}.`
        );
      }
    }
  }
}

function isSerializedReference(
  serializedWorkflow: string,
  relativePath: string
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const windows = normalized.replace(/\//g, "\\");
  const fileName = path.basename(normalized);
  const foldedWorkflow = foldPathForCompare(serializedWorkflow);
  return (
    foldedWorkflow.includes(foldPathForCompare(normalized)) ||
    foldedWorkflow.includes(foldPathForCompare(windows)) ||
    foldedWorkflow.includes(foldPathForCompare(fileName))
  );
}

async function resolvesToPublishedFile(
  target: string,
  publishedPaths: readonly string[],
  targetStats: Awaited<ReturnType<typeof fs.lstat>>
): Promise<boolean> {
  for (const publishedPath of publishedPaths) {
    try {
      const [targetRealPath, publishedRealPath, publishedStats] =
        await Promise.all([
          fs.realpath(target),
          fs.realpath(publishedPath),
          fs.stat(publishedPath),
        ]);
      if (
        foldPathForCompare(targetRealPath) ===
        foldPathForCompare(publishedRealPath)
      ) {
        return true;
      }
      if (
        targetStats.dev === publishedStats.dev &&
        targetStats.ino === publishedStats.ino
      ) {
        return true;
      }
    } catch {
      // A destination that was not published cannot alias a prune target.
    }
  }
  return false;
}

function isContainedPath(target: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return (
    relative !== "" &&
    !path.isAbsolute(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".."
  );
}

async function hasSymlinkAncestor(
  target: string,
  directory: string
): Promise<boolean> {
  const root = path.resolve(directory);
  let current = path.dirname(path.resolve(target));
  while (current !== root) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return true;
    }
    current = parent;
  }
  return false;
}

async function removeDirectoryWhenEmpty(
  directory: string,
  warnings: string[]
): Promise<void> {
  try {
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return;
    }
    const entries = await fs.readdir(directory);
    if (entries.length === 0) {
      await fs.rmdir(directory);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      warnings.push(
        `Could not remove empty bundle assets directory "${directory}": ${getErrorMessage(error)}.`
      );
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
