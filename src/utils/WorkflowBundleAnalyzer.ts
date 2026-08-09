import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import {
  buildFileReference,
  buildSelectionReference,
  buildSymbolReference,
} from "../completions/ContextReferenceBuilder";
import {
  parseAllFileReferences,
  maskFencedCodeBlocks,
  type FileReference,
} from "./FileReferenceParser";
import { PromptFileResolver } from "../core/PromptFileResolver";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { type ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import {
  isPathWithinAnyDirectory,
  isPathWithinDirectory,
} from "./PathSecurity";
import { BUNDLE_MANIFEST_FILE_NAME } from "../types/DashboardConstants";

export { BUNDLE_MANIFEST_FILE_NAME } from "../types/DashboardConstants";
export const BUNDLE_MANIFEST_VERSION = 1;

export type BundleGeneratedStore = "attachments" | "prompts" | "temp";
export type BundleReferenceSyntax = "@" | "selection" | "symbol";

export interface BundleDiagnostic {
  code: string;
  message: string;
  fieldPath?: string;
  token?: string;
}

export interface BundleInlinePlan {
  fieldPath: string;
  sourcePath: string;
  content: string;
}

export interface BundleCopyPlan {
  sourcePath: string;
  destinationPath: string;
  /** Workspace-relative path used in rewritten references and the manifest. */
  relativePath: string;
  contentHash: string;
  references: string[];
}

export interface BundlePlan {
  copies: BundleCopyPlan[];
  inlines: BundleInlinePlan[];
  warnings: BundleDiagnostic[];
  blockers: BundleDiagnostic[];
  pruneCandidates: string[];
  assetsDirectory?: string;
}

/** Fingerprint the user-visible bundle work, excluding filesystem metadata. */
export function getBundlePlanFingerprint(plan: BundlePlan): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        assetsDirectory: plan.assetsDirectory,
        copies: plan.copies.map((copy) => ({
          sourcePath: copy.sourcePath,
          destinationPath: copy.destinationPath,
          relativePath: copy.relativePath,
          contentHash: copy.contentHash,
          references: copy.references,
        })),
        inlines: plan.inlines,
        warnings: plan.warnings,
        blockers: plan.blockers,
        pruneCandidates: plan.pruneCandidates,
      })
    )
    .digest("hex");
}

export interface WorkflowBundleAnalysis {
  workflow: Record<string, unknown>;
  plan: BundlePlan;
}

export interface WorkflowBundleAnalyzerOptions {
  /** Primary workspace root. Copying and rewriting require this value. */
  workspaceRoot?: string;
  /** Additional trusted workspace roots, normally the other multi-root folders. */
  trustedRoots?: readonly string[];
  /** External roots approved for reading prompt-file candidates. */
  approvedExternalRoots?: readonly string[];
  namedRoots?: readonly ResolverWorkspaceFolder[];
  /** Semantic authored definition path, not the .runs working copy. */
  sourceDefinitionPath?: string;
  /** Absolute or workspace-relative Save As destination. */
  destinationPath?: string;
  /** Template exports cannot carry a sibling assets directory. */
  templateMode?: boolean;
}

interface PromptField {
  label: string;
  get(): unknown;
  set(value: string): void;
}

interface ResolvedReference {
  reference: FileReference;
  token: string;
  candidatePath?: string;
  canonicalPath?: string;
  generatedStore?: BundleGeneratedStore;
  bundleAssetsDirectory?: string;
  missingGeneratedStore?: BundleGeneratedStore;
  outsideTrustedRoots?: boolean;
  error?: unknown;
}

interface ExistingManifest {
  files: Set<string>;
  valid: boolean;
  error?: unknown;
}

interface RewriteRequest {
  field: PromptField;
  prompt: string;
  reference: ResolvedReference;
}

/**
 * Analyze a clean workflow for Save As portability without writing anything.
 *
 * The returned workflow is safe to serialize only after the caller executes
 * the returned copy plan. This separation is intentional: the later writer
 * can stage copies, publish the definition, and update/prune the manifest in
 * an atomic order without making discovery itself mutate the workspace.
 */
export async function analyzeWorkflowBundle(
  cleanWorkflow: Record<string, unknown>,
  sourceDefinitionPathOrOptions: string | WorkflowBundleAnalyzerOptions = {},
  additionalOptions: WorkflowBundleAnalyzerOptions = {}
): Promise<WorkflowBundleAnalysis> {
  const options =
    typeof sourceDefinitionPathOrOptions === "string"
      ? {
          ...additionalOptions,
          sourceDefinitionPath: sourceDefinitionPathOrOptions,
        }
      : sourceDefinitionPathOrOptions;
  const workflow = cloneWorkflowValue(cleanWorkflow) as Record<string, unknown>;
  const plan: BundlePlan = {
    copies: [],
    inlines: [],
    warnings: [],
    blockers: [],
    pruneCandidates: [],
  };

  const workspaceRoot = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : undefined;
  const namedRoots = options.namedRoots ?? [];
  const trustedRoots = dedupePaths([
    ...(options.trustedRoots ?? []),
    ...(workspaceRoot ? [workspaceRoot] : []),
    ...namedRoots.map((root) => root.fsPath),
  ]);
  const resolver = new PromptFileResolver({
    workspaceRoot,
    namedRoots,
    trustedRoots: trustedRoots.length ? trustedRoots : undefined,
    approvedExternalRoots: options.approvedExternalRoots,
  });
  const fields = collectPromptFields(workflow);
  const rewriteRequests: RewriteRequest[] = [];

  for (const field of fields) {
    const value = field.get();
    if (typeof value !== "string") {
      continue;
    }

    const wasInlined = await analyzeLonePromptFile(
      field,
      resolver,
      workspaceRoot,
      trustedRoots,
      options,
      plan
    );
    const prompt = field.get();
    if (
      typeof prompt === "string" &&
      (wasInlined || !looksLikePromptFile(resolver, value))
    ) {
      await analyzeInlineReferences(
        field,
        prompt,
        resolver,
        workspaceRoot,
        trustedRoots,
        options,
        plan,
        rewriteRequests
      );
    }
  }

  await finalizeCopyPlan(
    plan,
    workspaceRoot,
    trustedRoots,
    options,
    rewriteRequests
  );
  return { workflow, plan };
}

/** Class form for consumers that prefer dependency injection over a function. */
export class WorkflowBundleAnalyzer {
  analyze(
    cleanWorkflow: Record<string, unknown>,
    sourceDefinitionPathOrOptions: string | WorkflowBundleAnalyzerOptions = {},
    additionalOptions: WorkflowBundleAnalyzerOptions = {}
  ): Promise<WorkflowBundleAnalysis> {
    return analyzeWorkflowBundle(
      cleanWorkflow,
      sourceDefinitionPathOrOptions,
      additionalOptions
    );
  }
}

function collectPromptFields(workflow: Record<string, unknown>): PromptField[] {
  const fields: PromptField[] = [];
  if (typeof workflow.prompt === "string") {
    fields.push({
      label: "prompt",
      get: () => workflow.prompt,
      set: (value) => {
        workflow.prompt = value;
      },
    });
  }

  if (Array.isArray(workflow.steps)) {
    workflow.steps.forEach((step, index) => {
      if (
        !isRecord(step) ||
        step.type === "script" ||
        typeof step.prompt !== "string"
      ) {
        return;
      }
      fields.push({
        label: `steps[${index}].prompt`,
        get: () => step.prompt,
        set: (value) => {
          step.prompt = value;
        },
      });
    });
  }

  const finalStep = workflow.finalStep;
  if (isRecord(finalStep) && typeof finalStep.prompt === "string") {
    fields.push({
      label: "finalStep.prompt",
      get: () => finalStep.prompt,
      set: (value) => {
        finalStep.prompt = value;
      },
    });
  }
  return fields;
}

async function analyzeLonePromptFile(
  field: PromptField,
  resolver: PromptFileResolver,
  workspaceRoot: string | undefined,
  trustedRoots: readonly string[],
  options: WorkflowBundleAnalyzerOptions,
  plan: BundlePlan
): Promise<boolean> {
  const promptValue = field.get();
  if (
    typeof promptValue !== "string" ||
    !looksLikePromptFile(resolver, promptValue)
  ) {
    return false;
  }

  const resolution = await resolver.resolve(
    promptValue,
    options.sourceDefinitionPath
  );
  const candidate =
    resolution.status === "resolved" || resolution.status === "empty"
      ? resolution.path
      : resolution.candidates.find((value) =>
          isGeneratedStorePath(value, trustedRoots)
        );
  const absolutePromptPath = path.isAbsolute(promptValue.trim())
    ? path.resolve(promptValue.trim())
    : undefined;

  if (!workspaceRoot && looksLikeGeneratedStoreReference(promptValue.trim())) {
    addBlocker(
      plan,
      "workspace-root-required",
      `Cannot export ${field.label}: generated-store prompt reference "${promptValue.trim()}" requires a workspace root.`,
      field.label,
      promptValue.trim()
    );
    return false;
  }
  if (
    promptValue.includes("{{var}}") &&
    candidate &&
    isGeneratedStorePath(candidate, trustedRoots)
  ) {
    addBlocker(
      plan,
      "dynamic-generated-reference",
      `Cannot export ${field.label}: generated-store prompt reference "${promptValue.trim()}" contains {{var}}.`,
      field.label,
      promptValue.trim()
    );
    return false;
  }

  if (resolution.status === "missing" || resolution.status === "unreadable") {
    if (candidate && isGeneratedStorePath(candidate, trustedRoots)) {
      addBlocker(
        plan,
        "missing-generated-reference",
        `Cannot export ${field.label}: generated prompt reference "${promptValue.trim()}" is missing or unreadable.`,
        field.label,
        promptValue.trim()
      );
    } else if (
      absolutePromptPath &&
      !isPathWithinAnyDirectory(absolutePromptPath, trustedRoots)
    ) {
      addWarning(
        plan,
        "external-prompt-reference",
        `The absolute prompt path "${promptValue.trim()}" is outside the workspace and remains machine-specific.`,
        field.label,
        promptValue.trim()
      );
    }
    return false;
  }

  const canonicalPath = await realpathOrUndefined(resolution.path);
  const lexicalGeneratedStore = getGeneratedStore(
    resolution.path,
    trustedRoots
  );
  const generatedStore = canonicalPath
    ? getGeneratedStore(canonicalPath, trustedRoots)
    : undefined;
  const outsideTrustedRoots = canonicalPath
    ? !isPathWithinAnyDirectory(canonicalPath, trustedRoots)
    : true;

  if (outsideTrustedRoots) {
    if (lexicalGeneratedStore) {
      addBlocker(
        plan,
        "generated-source-symlink-escape",
        `Cannot export ${field.label}: generated prompt reference "${promptValue.trim()}" escapes the trusted workspace through a symbolic link.`,
        field.label,
        promptValue.trim()
      );
      return false;
    }
    if (absolutePromptPath) {
      addWarning(
        plan,
        "external-prompt-reference",
        `The absolute prompt path "${promptValue.trim()}" is outside the workspace and remains machine-specific.`,
        field.label,
        promptValue.trim()
      );
    }
    return false;
  }

  if (generatedStore === "temp" || generatedStore === "attachments") {
    addBlocker(
      plan,
      "unsupported-generated-prompt",
      `Cannot export ${field.label}: lone prompt reference "${promptValue.trim()}" points into .ctrlyoke/${generatedStore}; use an explicit inline reference or authored prompt file.`,
      field.label,
      promptValue.trim()
    );
    return false;
  }

  if (generatedStore !== "prompts") {
    return false;
  }

  field.set(resolution.content);
  plan.inlines.push({
    fieldPath: field.label,
    sourcePath: canonicalPath ?? resolution.path,
    content: resolution.content,
  });
  return true;
}

function looksLikePromptFile(
  resolver: PromptFileResolver,
  value: string
): boolean {
  return resolver.looksLikePromptFilePath(value);
}

async function analyzeInlineReferences(
  field: PromptField,
  prompt: string,
  resolver: PromptFileResolver,
  workspaceRoot: string | undefined,
  trustedRoots: readonly string[],
  options: WorkflowBundleAnalyzerOptions,
  plan: BundlePlan,
  rewriteRequests: RewriteRequest[]
): Promise<void> {
  const maskedPrompt = maskFencedCodeBlocks(prompt);
  const refs = parseAllFileReferences(maskedPrompt).filter(
    (ref) => ref.startOffset !== undefined && ref.endOffset !== undefined
  );
  if (refs.length === 0) {
    return;
  }

  for (const reference of refs) {
    const token = prompt.slice(reference.startOffset!, reference.endOffset!);
    const item = await resolveInlineReference(
      reference,
      token,
      resolver,
      trustedRoots,
      options.sourceDefinitionPath
    );

    if (item.outsideTrustedRoots) {
      addBlocker(
        plan,
        "external-inline-reference",
        `Cannot export ${field.label}: inline reference "${token}" resolves outside the workspace.`,
        field.label,
        token
      );
      continue;
    }

    const generatedStore = item.generatedStore ?? item.missingGeneratedStore;
    const bundleManagedAsset = item.bundleAssetsDirectory !== undefined;
    if (!workspaceRoot && looksLikeGeneratedStoreReference(reference.path)) {
      addBlocker(
        plan,
        "workspace-root-required",
        `Cannot export ${field.label}: generated-store reference "${token}" requires a workspace root.`,
        field.label,
        token
      );
      continue;
    }
    if (!generatedStore && !bundleManagedAsset) {
      continue;
    }
    if (generatedStore === "temp") {
      addBlocker(
        plan,
        "temporary-reference",
        `Cannot export ${field.label}: inline reference "${token}" points into .ctrlyoke/temp.`,
        field.label,
        token
      );
      continue;
    }
    if (generatedStore && item.reference.isDirectory) {
      addBlocker(
        plan,
        "generated-directory-reference",
        `Cannot export ${field.label}: directory reference "${token}" points into .ctrlyoke/${generatedStore}; use an explicit file reference.`,
        field.label,
        token
      );
      continue;
    }
    if (generatedStore && item.reference.path.includes("{{var}}")) {
      addBlocker(
        plan,
        "dynamic-generated-reference",
        `Cannot export ${field.label}: generated-store reference "${token}" contains {{var}}.`,
        field.label,
        token
      );
      continue;
    }
    if (!item.canonicalPath) {
      addBlocker(
        plan,
        "missing-generated-reference",
        `Cannot export ${field.label}: inline reference "${token}" is missing or unreadable.`,
        field.label,
        token
      );
      continue;
    }
    if (options.templateMode) {
      const referenceKind = generatedStore
        ? "generated-store"
        : "bundle-managed asset";
      addBlocker(
        plan,
        "template-generated-reference",
        `Cannot export template: ${field.label} contains ${referenceKind} reference "${token}"; templates cannot carry sibling assets.`,
        field.label,
        token
      );
      continue;
    }
    // The copy is assigned a destination after all sources are known, so
    // equal content can share one asset and basename collisions stay stable.
    const existing = plan.copies.find(
      (copy) => copy.sourcePath === item.canonicalPath
    );
    if (existing) {
      existing.references.push(token);
    } else {
      plan.copies.push({
        sourcePath: item.canonicalPath,
        destinationPath: "",
        relativePath: "",
        contentHash: "",
        references: [token],
      });
    }

    rewriteRequests.push({ field, prompt, reference: item });
  }
}

async function resolveInlineReference(
  reference: FileReference,
  token: string,
  resolver: PromptFileResolver,
  trustedRoots: readonly string[],
  sourceDefinitionPath?: string
): Promise<ResolvedReference> {
  const candidates = resolver.getCandidatePaths(
    reference.path,
    sourceDefinitionPath
  );
  const lexicalGenerated = candidates.find((candidate) =>
    isGeneratedStorePath(candidate, trustedRoots)
  );
  const candidate = await findReferenceCandidate(reference, candidates);
  if (!candidate) {
    const absolutePath = path.isAbsolute(reference.path)
      ? path.resolve(reference.path)
      : undefined;
    const outside = absolutePath
      ? !isPathWithinAnyDirectory(absolutePath, trustedRoots)
      : false;
    return {
      reference,
      token,
      missingGeneratedStore: lexicalGenerated
        ? getGeneratedStore(lexicalGenerated, trustedRoots)
        : undefined,
      outsideTrustedRoots: outside,
    };
  }

  const canonicalPath = await realpathOrUndefined(candidate);
  if (!canonicalPath) {
    return {
      reference,
      token,
      candidatePath: candidate,
      missingGeneratedStore: lexicalGenerated
        ? getGeneratedStore(lexicalGenerated, trustedRoots)
        : undefined,
      error: new Error("Reference could not be canonicalized"),
    };
  }

  const outsideTrustedRoots = !isPathWithinAnyDirectory(
    canonicalPath,
    trustedRoots
  );
  const lexicalEscape = lexicalGenerated && outsideTrustedRoots;
  return {
    reference,
    token,
    candidatePath: candidate,
    canonicalPath,
    generatedStore: getGeneratedStore(canonicalPath, trustedRoots),
    bundleAssetsDirectory: outsideTrustedRoots
      ? undefined
      : await getManifestedAssetsDirectory(canonicalPath, trustedRoots),
    missingGeneratedStore: lexicalEscape
      ? getGeneratedStore(lexicalGenerated, trustedRoots)
      : undefined,
    outsideTrustedRoots: outsideTrustedRoots || Boolean(lexicalEscape),
  };
}

async function findReferenceCandidate(
  reference: FileReference,
  candidates: readonly string[]
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (reference.isDirectory ? stat.isDirectory() : stat.isFile()) {
        await fs.access(candidate);
        return candidate;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return undefined;
      }
    }
  }
  return undefined;
}

async function finalizeCopyPlan(
  plan: BundlePlan,
  workspaceRoot: string | undefined,
  trustedRoots: readonly string[],
  options: WorkflowBundleAnalyzerOptions,
  rewriteRequests: readonly RewriteRequest[] = []
): Promise<void> {
  if (!workspaceRoot || options.templateMode) {
    return;
  }
  if (!options.destinationPath) {
    addBlocker(
      plan,
      "missing-destination",
      "Cannot export generated references without a Save As destination."
    );
    return;
  }

  const destinationPath = path.isAbsolute(options.destinationPath)
    ? path.resolve(options.destinationPath)
    : path.resolve(workspaceRoot, options.destinationPath);
  const assetsDirectory = deriveAssetsDirectory(destinationPath);
  plan.assetsDirectory = assetsDirectory;
  if (!(await validateExportDirectory(assetsDirectory, trustedRoots, plan))) {
    return;
  }

  const manifest = await readExistingManifest(assetsDirectory, plan);
  if (plan.copies.length === 0) {
    plan.pruneCandidates = manifest.valid ? [...manifest.files] : [];
    return;
  }
  const existingNames = await getExistingNames(assetsDirectory);
  const contents = new Map<string, Buffer>();
  for (const copy of plan.copies) {
    const content = await fs.readFile(copy.sourcePath).catch((error) => {
      addBlocker(
        plan,
        "unreadable-generated-reference",
        `Cannot export generated reference "${copy.sourcePath}": ${getErrorMessage(error)}.`,
        undefined,
        copy.sourcePath
      );
      return undefined;
    });
    if (!content) {
      continue;
    }
    contents.set(copy.sourcePath, content);
    copy.contentHash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
  }

  const uniqueCopies = dedupeByContent(plan.copies, contents);
  const usedNames = new Set<string>();
  const sourceByContent = new Map<string, BundleCopyPlan>();
  for (const copy of uniqueCopies.sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath)
  )) {
    const prior = sourceByContent.get(copy.contentHash);
    if (prior) {
      mergeCopyReferences(prior, copy);
      continue;
    }
    sourceByContent.set(copy.contentHash, copy);
    const baseName = path.basename(copy.sourcePath);
    const name = chooseAssetName(
      baseName,
      copy.contentHash,
      usedNames,
      existingNames,
      manifest.files
    );
    usedNames.add(name);
    const destination = path.join(assetsDirectory, name);
    copy.destinationPath = destination;
    copy.relativePath = toWorkflowRelativePath(
      destination,
      destinationPath
    );
  }

  plan.copies = [...sourceByContent.values()];
  const managedNames = new Set(
    plan.copies.map((copy) =>
      path.relative(assetsDirectory, copy.destinationPath).replace(/\\/g, "/")
    )
  );
  plan.pruneCandidates = manifest.valid
    ? [...manifest.files].filter((file) => !managedNames.has(file))
    : [];

  // Names are now known; apply the complete-token edits to every field by
  // replaying them from the recorded reference tokens. The field pass above
  // deliberately avoided regex or whole-prompt replacement.
  const sourceAliases = new Map<string, BundleCopyPlan>();
  for (const copy of uniqueCopies) {
    const selected = sourceByContent.get(copy.contentHash);
    if (selected) {
      sourceAliases.set(copy.sourcePath, selected);
    }
  }
  applyRewriteRequests(rewriteRequests, sourceAliases);
}

function applyRewriteRequests(
  requests: readonly RewriteRequest[],
  sourceAliases: ReadonlyMap<string, BundleCopyPlan>
): void {
  const byField = new Map<PromptField, RewriteRequest[]>();
  for (const request of requests) {
    const list = byField.get(request.field) ?? [];
    list.push(request);
    byField.set(request.field, list);
  }
  for (const [field, fieldRequests] of byField) {
    let result = fieldRequests[0]?.prompt ?? String(field.get());
    for (const request of [...fieldRequests].sort(
      (left, right) =>
        right.reference.reference.startOffset! -
        left.reference.reference.startOffset!
    )) {
      const sourcePath = request.reference.canonicalPath;
      const copy = sourcePath ? sourceAliases.get(sourcePath) : undefined;
      if (!copy?.relativePath) {
        continue;
      }
      const replacement = buildReference(
        request.reference.reference,
        copy.relativePath
      );
      result =
        result.slice(0, request.reference.reference.startOffset!) +
        replacement +
        result.slice(request.reference.reference.endOffset!);
    }
    field.set(result);
  }
}

function buildReference(
  reference: FileReference,
  relativePath: string
): string {
  if (reference.symbolName !== undefined) {
    return buildSymbolReference(
      relativePath,
      reference.symbolName,
      reference.startLine!,
      reference.endLine!,
      reference.symbolKind
    );
  }
  if (reference.startLine !== undefined && reference.endLine !== undefined) {
    return buildSelectionReference(
      relativePath,
      reference.startLine,
      reference.endLine
    );
  }
  return buildFileReference(relativePath);
}

function dedupeByContent(
  copies: readonly BundleCopyPlan[],
  contents: ReadonlyMap<string, Buffer>
): BundleCopyPlan[] {
  return copies.filter((copy) => contents.has(copy.sourcePath));
}

function mergeCopyReferences(
  target: BundleCopyPlan,
  source: BundleCopyPlan
): void {
  target.references.push(...source.references);
}

function chooseAssetName(
  baseName: string,
  contentHash: string,
  usedNames: Set<string>,
  existingNames: Set<string>,
  managedNames: Set<string>
): string {
  const baseAvailable =
    !usedNames.has(baseName) &&
    (!existingNames.has(baseName) || managedNames.has(baseName));
  if (baseAvailable) {
    return baseName;
  }
  const extension = path.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  const hashed = `${stem}-${contentHash.slice(0, 8)}${extension}`;
  if (
    !usedNames.has(hashed) &&
    (!existingNames.has(hashed) || managedNames.has(hashed))
  ) {
    return hashed;
  }
  let counter = 2;
  while (true) {
    const candidate = `${stem}-${contentHash.slice(0, 8)}-${counter}${extension}`;
    if (
      !usedNames.has(candidate) &&
      (!existingNames.has(candidate) || managedNames.has(candidate))
    ) {
      return candidate;
    }
    counter++;
  }
}

async function validateExportDirectory(
  assetsDirectory: string,
  trustedRoots: readonly string[],
  plan: BundlePlan
): Promise<boolean> {
  if (!isPathWithinAnyDirectory(assetsDirectory, trustedRoots)) {
    addBlocker(
      plan,
      "assets-directory-outside-workspace",
      `Cannot export generated references: assets directory "${assetsDirectory}" is outside the workspace.`
    );
    return false;
  }
  let ancestor = assetsDirectory;
  while (true) {
    try {
      const stat = await fs.lstat(ancestor);
      if (stat.isSymbolicLink()) {
        addBlocker(
          plan,
          "assets-directory-symlink",
          `Cannot export generated references: assets directory or its ancestor "${ancestor}" is a symbolic link.`
        );
        return false;
      }
      const realAncestor = await fs.realpath(ancestor);
      const realRoots = await realpathRoots(trustedRoots);
      if (!isPathWithinAnyDirectory(realAncestor, realRoots)) {
        addBlocker(
          plan,
          "assets-directory-symlink-escape",
          `Cannot export generated references: assets directory escapes the workspace through "${ancestor}".`
        );
        return false;
      }
      if (path.resolve(ancestor) === path.resolve(assetsDirectory)) {
        if (!stat.isDirectory()) {
          addBlocker(
            plan,
            "assets-directory-not-directory",
            `Cannot export generated references: "${assetsDirectory}" exists but is not a directory.`
          );
          return false;
        }
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        addBlocker(
          plan,
          "assets-directory-unreadable",
          `Cannot validate assets directory "${assetsDirectory}": ${getErrorMessage(error)}.`
        );
        return false;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        addBlocker(
          plan,
          "assets-directory-no-ancestor",
          `Cannot validate assets directory "${assetsDirectory}".`
        );
        return false;
      }
      ancestor = parent;
    }
  }
}

async function readExistingManifest(
  assetsDirectory: string,
  plan: BundlePlan
): Promise<ExistingManifest> {
  const manifest = await loadExistingManifest(assetsDirectory);
  if (manifest.error) {
    addWarning(
      plan,
      "invalid-assets-manifest",
      `Ignoring invalid assets manifest "${path.join(
        assetsDirectory,
        BUNDLE_MANIFEST_FILE_NAME
      )}": ${getErrorMessage(manifest.error)}.`
    );
  }
  return manifest;
}

async function loadExistingManifest(
  assetsDirectory: string
): Promise<ExistingManifest> {
  const manifestPath = path.join(assetsDirectory, BUNDLE_MANIFEST_FILE_NAME);
  try {
    const value = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      version?: unknown;
      files?: unknown;
    };
    if (
      value.version !== BUNDLE_MANIFEST_VERSION ||
      !Array.isArray(value.files)
    ) {
      throw new Error("unsupported manifest version or file list");
    }
    const files = value.files.filter(isSafeManifestPath);
    if (files.length !== value.files.length) {
      throw new Error("manifest contains unsafe paths");
    }
    return { files: new Set(files), valid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { files: new Set(), valid: false };
    }
    return { files: new Set(), valid: false, error };
  }
}

async function getManifestedAssetsDirectory(
  filePath: string,
  trustedRoots: readonly string[]
): Promise<string | undefined> {
  let directory = path.dirname(filePath);
  while (isPathWithinAnyDirectory(directory, trustedRoots)) {
    if (/\.assets$/i.test(path.basename(directory))) {
      const relativePath = path
        .relative(directory, filePath)
        .replace(/\\/g, "/");
      if (!isSafeManifestPath(relativePath)) {
        return undefined;
      }
      const manifest = await loadExistingManifest(directory);
      return manifest.valid && manifest.files.has(relativePath)
        ? directory
        : undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return undefined;
}

async function getExistingNames(assetsDirectory: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(assetsDirectory, { withFileTypes: true });
    return new Set(entries.map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

function deriveAssetsDirectory(destinationPath: string): string {
  const baseName = path.basename(destinationPath);
  const stem = baseName
    .replace(/\.ctrlyoke\.(?:json|ya?ml)$/i, "")
    .replace(/\.prompt\.md$/i, "");
  return path.join(path.dirname(destinationPath), `${stem}.assets`);
}

function toWorkflowRelativePath(
  assetPath: string,
  destinationPath: string
): string {
  return `./${path
    .relative(path.dirname(destinationPath), assetPath)
    .replace(/\\/g, "/")}`;
}

function isGeneratedStorePath(
  filePath: string,
  trustedRoots: readonly string[]
): boolean {
  return getGeneratedStore(filePath, trustedRoots) !== undefined;
}

function getGeneratedStore(
  filePath: string,
  trustedRoots: readonly string[]
): BundleGeneratedStore | undefined {
  for (const root of trustedRoots) {
    const generatedRoot = path.join(root, PATH_CONSTANTS.CTRLYOKE_DIR);
    for (const store of ["attachments", "prompts", "temp"] as const) {
      if (isPathWithinDirectory(filePath, path.join(generatedRoot, store))) {
        return store;
      }
    }
  }
  return undefined;
}

function looksLikeGeneratedStoreReference(referencePath: string): boolean {
  const normalized = referencePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return ["attachments", "prompts", "temp"].some(
    (store) =>
      normalized.startsWith(`${PATH_CONSTANTS.CTRLYOKE_DIR}/${store}/`) ||
      normalized.startsWith(`${store}/`)
  );
}

async function realpathOrUndefined(
  filePath: string
): Promise<string | undefined> {
  try {
    return path.resolve(await fs.realpath(filePath));
  } catch {
    return undefined;
  }
}

async function realpathRoots(roots: readonly string[]): Promise<string[]> {
  return Promise.all(
    roots.map(
      async (root) => (await realpathOrUndefined(root)) ?? path.resolve(root)
    )
  );
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((value) => path.resolve(value)))];
}

function isSafeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  return normalized
    .split("/")
    .every((segment) => segment !== ".." && segment !== "");
}

function cloneWorkflowValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneWorkflowValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        cloneWorkflowValue(child),
      ])
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addWarning(
  plan: BundlePlan,
  code: string,
  message: string,
  fieldPath?: string,
  token?: string
): void {
  plan.warnings.push({ code, message, fieldPath, token });
}

function addBlocker(
  plan: BundlePlan,
  code: string,
  message: string,
  fieldPath?: string,
  token?: string
): void {
  plan.blockers.push({ code, message, fieldPath, token });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
