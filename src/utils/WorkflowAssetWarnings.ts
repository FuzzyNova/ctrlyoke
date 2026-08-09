import * as fs from "fs/promises";
import * as path from "path";
import {
  maskFencedCodeBlocks,
  parseAllFileReferences,
} from "./FileReferenceParser";
import { isPathWithinDirectory } from "./PathSecurity";

/**
 * Find exported asset directories referenced by prompt text that are absent
 * from the workspace. The result is directory-level so several missing
 * tokens in one bundle produce one diagnostic.
 */
export async function findMissingWorkflowAssetDirectories(
  promptTexts: readonly string[],
  workspaceRoot?: string
): Promise<string[]> {
  if (!workspaceRoot) {
    return [];
  }

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const missingDirectories = new Set<string>();

  for (const promptText of promptTexts) {
    const references = parseAllFileReferences(maskFencedCodeBlocks(promptText));
    for (const reference of references) {
      const assetsDirectory = getReferencedAssetsDirectory(
        reference.path,
        resolvedWorkspaceRoot
      );
      if (
        !assetsDirectory ||
        !isPathWithinDirectory(assetsDirectory, resolvedWorkspaceRoot)
      ) {
        continue;
      }

      try {
        const stats = await fs.stat(assetsDirectory);
        if (stats.isDirectory()) {
          continue;
        }
      } catch {
        // A missing or unreadable assets directory is the load-time condition
        // this warning is intended to surface. The editor still validates the
        // individual reference token through CONTEXT_REFS_VALIDATION.
      }

      const relativeDirectory = path
        .relative(resolvedWorkspaceRoot, assetsDirectory)
        .split(path.sep)
        .join("/");
      if (relativeDirectory) {
        missingDirectories.add(relativeDirectory);
      }
    }
  }

  return [...missingDirectories].sort();
}

function getReferencedAssetsDirectory(
  referencePath: string,
  workspaceRoot: string
): string | undefined {
  const resolvedReferencePath = path.isAbsolute(referencePath)
    ? path.resolve(referencePath)
    : path.resolve(workspaceRoot, referencePath);
  const normalizedPath = path.normalize(resolvedReferencePath);
  const assetsSegment = /(?:^|[\\/])[^\\/]+\.assets(?:[\\/]|$)/i.exec(
    normalizedPath
  );

  if (!assetsSegment) {
    return undefined;
  }

  return normalizedPath
    .slice(0, assetsSegment.index + assetsSegment[0].length)
    .replace(/[\\/]$/, "");
}
