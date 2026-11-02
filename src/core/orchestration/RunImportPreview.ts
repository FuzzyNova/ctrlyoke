import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IntegrationFactory } from "../IntegrationFactory";
import { CliSessionResolverAdapter } from "../harness/shared/CliSessionResolverAdapter";
import { RUN_BUNDLE_FILES } from "../../types/RunBundleTypes";
import type {
  PromptFile,
  PromptStep,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import {
  HARNESS_IDS,
  PRIOR_CONTEXT_KEYWORDS,
} from "../../types/DashboardConstants";
import type { RunImportPreview } from "../../types/RunImportPreviewTypes";
import { REDACTION_MARKER } from "../../types/PreviewRedactor";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { PropertyResolver } from "../../utils/PropertyResolver";
import { isScriptStep } from "../../types/CtrlYokeTypes";
import {
  getDeclaredSecretGrants,
  findUnapprovedSecretGrants,
} from "../../utils/SecretResolver";
import { parseAtReferences } from "../../utils/FileReferenceParser";
import { execGit } from "../../utils/GitUtils";
import { readRunBundleHeader, type RunBundleHeader } from "./RunBundleReader";
import type { ICliProvider } from "../harness/shared/interfaces/ICliProvider";

interface PreviewRuntime extends PromptFile {
  _runtime?: {
    currentIndex?: number;
    finalStep?: { sessionId?: string };
  };
}

export interface RunImportPreviewDependencies {
  readBundleHeader?: typeof import("./RunBundleReader").readRunBundleHeader;
  resolveSession?: (
    step: PromptStep,
    workflow: PromptFile,
    stepIndex: number,
    allSteps: WorkflowStep[]
  ) => Promise<{
    sessionId?: string;
    availability: "available" | "missing" | "unknown" | "malformed";
  }>;
  createProvider?: (
    harness: import("../../types/DashboardConstants").HarnessId
  ) => ICliProvider;
  isSecretApproved?: (workspaceRoot: string, name: string) => boolean;
  git?: (workspaceRoot: string, args: readonly string[]) => Promise<string>;
  lineageRepository?: Pick<
    WorkflowLineageRepository,
    "listLineageKeys" | "tryReadDescriptor"
  >;
}

/** Builds an immutable, settings-aware import preview without writing workspace state. */
export class RunImportPreviewService {
  async preview(
    bundleDir: string,
    workspaceRoot: string,
    dependencies: RunImportPreviewDependencies = {}
  ): Promise<RunImportPreview> {
    const header = await (dependencies.readBundleHeader ?? readRunBundleHeader)(
      bundleDir,
      workspaceRoot
    );
    const continuation = header.manifest.continuation;
    const runtime = (header.runtime ?? {}) as PreviewRuntime;
    const workflow = { ...header.definition, ...runtime } as PromptFile;
    const steps = (runtime.steps ??
      header.definition.steps ??
      []) as WorkflowStep[];
    const pendingIndexes = new Set<number>();
    if (continuation?.nextStep.kind === "queue") {
      for (
        let index = continuation.nextStep.stepIndex;
        index < steps.length;
        index++
      ) {
        if (steps[index]?._runtime?.completedAt === undefined)
          pendingIndexes.add(index);
      }
    }
    const finalStepRunsAgain =
      !!continuation &&
      !!workflow.finalStep &&
      (continuation.nextStep.kind === "finalStep" ||
        pendingIndexes.size > 0 ||
        continuation.pendingStepCount > 0);
    const pendingEntries = [...pendingIndexes].map((index) => ({
      step: steps[index]!,
      index,
    }));
    if (finalStepRunsAgain && workflow.finalStep)
      pendingEntries.push({ step: workflow.finalStep, index: steps.length });

    const provenance: RunImportPreview["provenance"] = {
      workflowName: header.manifest.lineage.workflowName,
      sourceRoot: header.manifest.sourceRoot,
      exportedAt: header.manifest.exportedAt,
      exportedByVersion: header.manifest.exportedByVersion,
    };
    const alreadyImported = await this.findExistingImport(
      header,
      workspaceRoot,
      dependencies.lineageRepository ?? new WorkflowLineageRepository()
    );
    if (alreadyImported) provenance.alreadyImported = alreadyImported;

    const blockers: RunImportPreview["blockers"] = [];
    let continuationPreview: RunImportPreview["continuation"];
    if (continuation) {
      const baseCommit = continuation.workspace.baseCommit;
      const git =
        dependencies.git ??
        (async (root, args) =>
          (await execGit(["-C", root, ...args])).stdout.trim());
      let exists = false;
      let checkoutClean = false;
      let checkoutAtBaseCommit = false;
      try {
        await git(workspaceRoot, ["cat-file", "-e", `${baseCommit}^{commit}`]);
        exists = true;
      } catch {
        /* missing locally */
      }
      if (!exists)
        blockers.push({
          code: "base-commit-missing",
          message: `push/fetch commit ${baseCommit.slice(0, 7)}`,
          path: baseCommit,
        });
      try {
        checkoutClean =
          (await git(workspaceRoot, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ])) === "";
        checkoutAtBaseCommit =
          (await git(workspaceRoot, ["rev-parse", "HEAD"])) === baseCommit;
      } catch {
        /* not a usable checkout */
      }
      const mode = continuation.worktreeMode;
      const allowedChangesTargets =
        mode === "managed"
          ? (["managed-worktree", "skip"] as const)
          : mode === "named"
            ? (["current-checkout", "managed-worktree", "skip"] as const)
            : (["current-checkout", "managed-worktree", "skip"] as const);
      const defaultChangesTarget =
        mode === "managed"
          ? "managed-worktree"
          : checkoutClean && checkoutAtBaseCommit
            ? "current-checkout"
            : "managed-worktree";
      continuationPreview = {
        baseCommit: {
          commit: baseCommit,
          exists,
          ...(!exists
            ? { instruction: `push/fetch commit ${baseCommit.slice(0, 7)}` }
            : {}),
        },
        worktreeMode: mode,
        defaultChangesTarget,
        allowedChangesTargets: [...allowedChangesTargets],
        checkoutClean,
        checkoutAtBaseCommit,
        patchFileCount: continuation.workspace.patch?.files ?? 0,
      };
    }

    const sessions: RunImportPreview["sessions"] = [];
    const isRedacted = (step: WorkflowStep): boolean => {
      if (
        (header.manifest.redaction.byFile?.[RUN_BUNDLE_FILES.RUNTIME] ?? 0) <= 0
      )
        return false;
      return JSON.stringify(step).includes(REDACTION_MARKER);
    };
    const previewSteps = await Promise.all(
      pendingEntries.map(async ({ step, index: actualIndex }) => {
        const isScript = isScriptStep(step);
        const resolved = isScript
          ? undefined
          : PropertyResolver.resolve(step as PromptStep, workflow, {
              hostCanProvidePty: false,
            });
        const grants = getDeclaredSecretGrants(step, workflow);
        const unapproved = new Set(
          findUnapprovedSecretGrants(grants, workspaceRoot)
        );
        const customApproval = dependencies.isSecretApproved;
        const secretGrants = grants.map((name) => ({
          name,
          approved: customApproval
            ? customApproval(workspaceRoot, name)
            : !unapproved.has(name),
        }));
        const provenanceStep = header.manifest.provenance.steps.find(
          (item) => item.stepIndex === actualIndex
        );
        if (!isScript && resolved) {
          const harness = resolved.harness ?? HARNESS_IDS.COPILOT_CLI;
          const provider = (
            dependencies.createProvider ??
            IntegrationFactory.createCapabilityProvider
          )(harness);
          const resolveSession =
            dependencies.resolveSession ??
            (async (prompt, wf, index, allSteps) => {
              const resolver = new CliSessionResolverAdapter({
                getIntegrationHarness: () => harness,
                provider,
                getWorkspaceRoot: () => workspaceRoot,
              });
              const result = await resolver.resolve(prompt, {
                promptIndex: index,
                allPrompts: allSteps,
                workflowFile: wf,
                hostCanProvidePty: false,
                finalStepSessionId: wf.finalStep?._runtime?.sessionId as
                  string | undefined,
              });
              return {
                sessionId: result.probedSessionId ?? result.resolvedSessionId,
                availability: result.sessionAvailability ?? "unknown",
              };
            });
          const session = await resolveSession(
            step as PromptStep,
            workflow,
            actualIndex,
            steps
          );
          if (
            session.sessionId ||
            session.availability === "missing" ||
            session.availability === "malformed"
          ) {
            const executedStepIndices = [
              ...steps.flatMap((candidate, index) =>
                candidate._runtime?.sessionId === session.sessionId &&
                session.sessionId
                  ? [index]
                  : []
              ),
              ...(workflow.finalStep?._runtime?.sessionId ===
                session.sessionId && session.sessionId
                ? [steps.length]
                : []),
            ];
            sessions.push({
              stepIndex: actualIndex,
              ...(session.sessionId ? { sessionId: session.sessionId } : {}),
              harness,
              availability: session.availability,
              executedStepIndices,
              notFromThisRun:
                !!session.sessionId && executedStepIndices.length === 0,
              ...(resolved.priorContext === PRIOR_CONTEXT_KEYWORDS.NONE
                ? {
                    hint: "This is a reply-to-step continuation; priorContext is explicitly none.",
                  }
                : {}),
            });
          }
        }
        return {
          stepIndex: actualIndex,
          ...(step.name ? { name: step.name } : {}),
          kind: isScript ? ("script" as const) : ("prompt" as const),
          ...(!isScript
            ? { promptPreview: (step as PromptStep).prompt }
            : {
                script: {
                  script: step.script,
                  env: step.env,
                  shell: step.shell,
                },
              }),
          ...(!isScript && resolved?.preCondition
            ? { preCondition: resolved.preCondition }
            : {}),
          ...(!isScript && resolved?.endCondition
            ? { endCondition: resolved.endCondition }
            : {}),
          ...(resolved?.additionalArgs
            ? { additionalArgs: resolved.additionalArgs }
            : {}),
          ...(resolved?.mcpServers !== undefined
            ? { mcpServers: resolved.mcpServers }
            : {}),
          secretGrants,
          ...(resolved?.harness ? { harness: resolved.harness } : {}),
          ...(resolved?.model ? { model: resolved.model } : {}),
          ...(provenanceStep?.harness || provenanceStep?.model
            ? {
                previouslyUsed: {
                  ...(provenanceStep.harness
                    ? { harness: provenanceStep.harness }
                    : {}),
                  ...(provenanceStep.model
                    ? { model: provenanceStep.model }
                    : {}),
                },
              }
            : {}),
          promptRedacted: isRedacted(step),
        };
      })
    );

    await this.findMissingAssets(
      pendingEntries,
      header,
      workspaceRoot,
      blockers
    );
    sessions.sort((left, right) => left.stepIndex - right.stepIndex);
    return {
      provenance,
      continuable: !!continuation,
      ...(continuationPreview ? { continuation: continuationPreview } : {}),
      pendingSteps: previewSteps,
      sessions,
      blockers,
    };
  }

  private async findExistingImport(
    header: RunBundleHeader,
    workspaceRoot: string,
    repository?: RunImportPreviewDependencies["lineageRepository"]
  ): Promise<{ workflowKey: string; runRef?: string } | undefined> {
    if (!repository) return undefined;
    for (const workflowKey of await repository.listLineageKeys(workspaceRoot)) {
      const descriptor = await repository.tryReadDescriptor(
        workspaceRoot,
        workflowKey
      );
      const imported = descriptor?.importedFrom;
      if (
        imported?.kind === "runBundle" &&
        imported.provenance.workflowKey ===
          header.manifest.provenance.workflowKey &&
        imported.provenance.runRef === header.manifest.provenance.runRef &&
        imported.sourceRoot === header.manifest.sourceRoot &&
        imported.exportedAt === header.manifest.exportedAt
      )
        return {
          workflowKey,
          ...(descriptor?.latestRunRef
            ? { runRef: descriptor.latestRunRef }
            : {}),
        };
    }
    return undefined;
  }

  private async findMissingAssets(
    entries: Array<{ step: WorkflowStep; index: number }>,
    header: RunBundleHeader,
    workspaceRoot: string,
    blockers: RunImportPreview["blockers"]
  ): Promise<void> {
    const assetPaths = new Set(
      (header.manifest.assets ?? []).map((asset) =>
        asset.path.replace(/\\/g, "/").toLowerCase()
      )
    );
    for (const { step, index } of entries) {
      const text = "prompt" in step ? step.prompt : step.script;
      for (const reference of parseAtReferences(text)) {
        const normalized = reference.path.replace(/\\/g, "/");
        const storeMatch = normalized.match(
          /(?:^|\/)(?:attachments|prompts)\/(.+)$/i
        );
        if (!storeMatch) continue;
        const suffix = storeMatch[0].replace(/^\//, "").toLowerCase();
        const bundled = [...assetPaths].some((asset) => asset.endsWith(suffix));
        if (bundled) continue;
        try {
          await fs.access(
            path.isAbsolute(normalized)
              ? normalized
              : path.resolve(workspaceRoot, normalized)
          );
        } catch {
          blockers.push({
            code: "missing-asset",
            message: `Pending step references a missing bundled asset: ${reference.path}`,
            stepIndex: index,
            path: reference.path,
          });
        }
      }
    }
  }
}
