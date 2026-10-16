import * as path from "path";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import { parseAllFileReferences } from "../utils/FileReferenceParser";
import {
  getTrustedSourceDefinitionDir,
  resolveReferencePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import { PromptFileResolver } from "./PromptFileResolver";

/**
 * Rebase source-file-relative paths before steps are moved into another
 * workflow. Inline references become workspace-relative; standalone prompt
 * files use a destination-relative path because the resolver requires a
 * `./`/`../` marker to distinguish a path from prompt text.
 */
export async function rebaseWorkflowStepPaths(
  steps: readonly WorkflowStep[],
  sourceDefinitionPath: string,
  workspaceRoot: string,
  options: {
    namedRoots?: readonly ResolverWorkspaceFolder[];
    trustedRoots?: readonly string[];
    destinationDefinitionPath?: string;
  } = {}
): Promise<WorkflowStep[]> {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const trustedRoots = options.trustedRoots ?? [resolvedWorkspaceRoot];
  const sourceDefinitionDir = getTrustedSourceDefinitionDir(
    sourceDefinitionPath,
    trustedRoots
  );
  const promptResolver = new PromptFileResolver({
    workspaceRoot: resolvedWorkspaceRoot,
    namedRoots: options.namedRoots,
    trustedRoots,
  });

  return Promise.all(
    steps.map(async (step) => {
      if (!("prompt" in step) || typeof step.prompt !== "string") {
        return { ...step };
      }

      const rebaseText = async (text: string): Promise<string> => {
        let rebasedText = text;
        if (promptResolver.looksLikePromptFilePath(rebasedText)) {
          const resolved = await promptResolver.resolvePath(
            rebasedText,
            sourceDefinitionPath
          );
          if (resolved.status === "resolved" && resolved.path) {
            rebasedText = destinationPromptFileReference(
              resolved.path,
              resolvedWorkspaceRoot,
              options.namedRoots,
              options.destinationDefinitionPath
            );
          }
        }

        const refs = parseAllFileReferences(rebasedText).filter((reference) => {
          const normalized = reference.path.replace(/\\/g, "/");
          return normalized.startsWith("./") || normalized.startsWith("../");
        });
        for (const reference of [...refs].reverse()) {
          if (!sourceDefinitionDir) continue;
          let absolutePath: string;
          try {
            absolutePath = resolveReferencePath(reference.path, {
              primaryRoot: resolvedWorkspaceRoot,
              namedRoots: options.namedRoots ?? [],
              sourceDefinitionDir,
            }).absolutePath;
          } catch {
            continue;
          }
          const replacement = workspaceRelativeReference(
            absolutePath,
            resolvedWorkspaceRoot,
            options.namedRoots
          );
          const token = rebasedText.slice(
            reference.startOffset,
            reference.endOffset
          );
          const pathOffset = token.indexOf(reference.path);
          if (pathOffset < 0) continue;
          const rebasedToken =
            token.slice(0, pathOffset) +
            replacement +
            token.slice(pathOffset + reference.path.length);
          rebasedText =
            rebasedText.slice(0, reference.startOffset) +
            rebasedToken +
            rebasedText.slice(reference.endOffset);
        }
        return rebasedText;
      };

      const prompt = await rebaseText(step.prompt);
      const endCondition = step.endCondition;
      const rebasedEndCondition = endCondition
        ? {
            ...endCondition,
            ...(typeof endCondition.retryPrompt === "string" && {
              retryPrompt: await rebaseText(endCondition.retryPrompt),
            }),
            ...(typeof endCondition.passRetryPrompt === "string" && {
              passRetryPrompt: await rebaseText(endCondition.passRetryPrompt),
            }),
          }
        : endCondition;
      return {
        ...step,
        prompt,
        ...(rebasedEndCondition !== undefined && {
          endCondition: rebasedEndCondition,
        }),
      };
    })
  );
}

function destinationPromptFileReference(
  absolutePath: string,
  workspaceRoot: string,
  namedRoots: readonly ResolverWorkspaceFolder[] = [],
  destinationDefinitionPath?: string
): string {
  const resolvedPath = path.resolve(absolutePath);
  const primaryRelative = path.relative(workspaceRoot, resolvedPath);
  if (!path.isAbsolute(primaryRelative) && !primaryRelative.startsWith("..")) {
    const relative = destinationDefinitionPath
      ? path.relative(path.dirname(destinationDefinitionPath), resolvedPath)
      : primaryRelative;
    const portable = toPortablePath(relative);
    return portable.startsWith("../") || portable.startsWith("./")
      ? portable
      : `./${portable}`;
  }

  for (const root of namedRoots) {
    const relative = path.relative(path.resolve(root.fsPath), resolvedPath);
    if (!path.isAbsolute(relative) && !relative.startsWith("..")) {
      return toPortablePath(path.join(root.name, relative));
    }
  }
  return resolvedPath;
}

function workspaceRelativeReference(
  absolutePath: string,
  workspaceRoot: string,
  namedRoots: readonly ResolverWorkspaceFolder[] = []
): string {
  const resolvedPath = path.resolve(absolutePath);
  const primaryRelative = path.relative(workspaceRoot, resolvedPath);
  if (!path.isAbsolute(primaryRelative) && !primaryRelative.startsWith("..")) {
    return toPortablePath(primaryRelative);
  }

  for (const root of namedRoots) {
    const relative = path.relative(path.resolve(root.fsPath), resolvedPath);
    if (!path.isAbsolute(relative) && !relative.startsWith("..")) {
      return toPortablePath(path.join(root.name, relative));
    }
  }

  // The reference remains meaningful when it is outside the workspace roots,
  // and inline context resolution will still apply its normal trust checks.
  return resolvedPath;
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
