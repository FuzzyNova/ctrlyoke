import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { suite, test } from "mocha";

export const FEEDBACK_SOURCE_AUDIT_BASELINES = {
  directMessage: {
    // Shrank from 50 to 49: SecretGrantsTrustPrompt.ts's `vscode` dependency
    // was removed entirely (it now goes through UserInteractionPort), so its
    // one showInformationMessage() call — and the file's allowlist entry —
    // are both gone rather than migrated.
    // Shrank from 49 to 46: the host-neutral trusted roots approval flow
    // moved ExternalFileTrustPrompt.ts's three direct show*Message calls
    // behind UserInteractionPort too.
    boundary: 46,
    reusable: 0,
    boundaryFiles: [
      "src/completions/ContextMenuReferenceCommands.ts",
      "src/dev/DevCommands.ts",
      "src/extension.ts",
      "src/platform/VsCodeAdapter.ts",
      "src/scm/ScmCommitCommand.ts",
      "src/ui/ExternalFileTrustPrompt.ts",
      "src/ui/NotificationManager.ts",
      "src/ui/WebviewMessageRouter.ts",
    ] as readonly string[],
  },
  adapterUi: 0,
  webviewToast: 1,
} as const;

const DIRECT_MESSAGE_NAMES = new Set([
  "showInformationMessage",
  "showWarningMessage",
  "showErrorMessage",
]);

const ADAPTER_UI_NAMES = new Set([
  "log",
  "warn",
  "error",
  "showProgress",
  "showChoice",
]);

const TOAST_NAMES = new Set(["showToast", "enqueueToast"]);

// Phase 1 steps 2, 3, 4, 5, 7, 8, and 9 progressively shrink this graph;
// later phases remove the remaining downstream VS Code importers.
// Shrunk from 13 to 8: WorkflowOrchestrator no longer imports the
// StatusBarManager, VsCodeAdapter, or LicenseService host implementations;
// those capabilities are injected by extension.ts, and its workspace-folder
// resolver is now injected as a path callback. Its runner watcher is now
// supplied by the FileWatcherFactory port.
const vscodeImportersReachableFromOrchestrator = 8;

const vscodeImporterFilesReachableFromOrchestrator = [
  "src/core/orchestration/ExecutionRootCoordinationWatchSession.ts",
  "src/core/orchestration/ExternalRunWatchSession.ts",
  "src/core/orchestration/PromptFileWatcher.ts",
  "src/core/orchestration/WorkflowCommandHandler.ts",
  "src/ui/ExternalFileTrustPrompt.ts",
  "src/utils/AttachmentBuilders.ts",
  "src/utils/Log.ts",
  "src/utils/ModelRegistry.ts",
] as const;

// Phase 1 item 9 removes the orchestrator's direct vscode import.
const orchestratorDirectVsCodeImports = 0;

// Shrunk from 1 to 0: the orchestrator now accepts project-owned dependencies
// instead of a VS Code ExtensionContext constructor parameter.
const orchestratorVsCodeConstructorParams = 0;

// Already clean; this guard prevents WorkflowInstance.ts from regressing.
const workflowInstanceDirectVsCodeImports = 0;

// Shrunk from 7 to 1: six orchestrator constructions moved to the extension
// composition root; TemplateManager remains for Phase 3.
const coreVsCodeAdapterConstructions = 1;

interface SourceAuditSite {
  file: string;
  line: number;
  member: string;
}

function findProductionSourceFiles(repoRoot: string): string[] {
  const sourceRoot = path.join(repoRoot, "src");
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(sourceRoot, filePath).split(path.sep)[0] !== "test") {
          visit(filePath);
        }
        continue;
      }

      if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        files.push(filePath);
      }
    }
  }

  visit(sourceRoot);
  return files.sort();
}

function getPropertyAccessName(node: ts.Node): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
}

function isVscodeWindowMessageCall(node: ts.CallExpression): boolean {
  const messageAccess = node.expression;
  if (!ts.isPropertyAccessExpression(messageAccess)) return false;
  if (!DIRECT_MESSAGE_NAMES.has(messageAccess.name.text)) return false;

  const windowAccess = messageAccess.expression;
  return (
    ts.isPropertyAccessExpression(windowAccess) &&
    windowAccess.name.text === "window" &&
    ts.isIdentifier(windowAccess.expression) &&
    windowAccess.expression.text === "vscode"
  );
}

function isPlatformReceiver(node: ts.Node): boolean {
  return (
    (ts.isIdentifier(node) && node.text === "platform") ||
    getPropertyAccessName(node) === "platform"
  );
}

function isAdapterUiCall(node: ts.CallExpression): boolean {
  const adapterAccess = node.expression;
  return (
    ts.isPropertyAccessExpression(adapterAccess) &&
    ADAPTER_UI_NAMES.has(adapterAccess.name.text) &&
    isPlatformReceiver(adapterAccess.expression)
  );
}

function isDirectToastCall(node: ts.CallExpression): boolean {
  const toastAccess = node.expression;
  return (
    ts.isPropertyAccessExpression(toastAccess) &&
    TOAST_NAMES.has(toastAccess.name.text)
  );
}

function isMessageHandlerAssignment(
  node: ts.Node,
  messageType: string
): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(current.left) &&
      ts.isIdentifier(current.left.expression) &&
      current.left.expression.text === "handlers" &&
      ts.isPropertyAccessExpression(current.left.argumentExpression) &&
      ts.isIdentifier(current.left.argumentExpression.expression) &&
      current.left.argumentExpression.expression.text === "MESSAGE_TYPES" &&
      current.left.argumentExpression.name.text === messageType
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isAllowedWebviewToastCall(
  node: ts.CallExpression,
  file: string
): boolean {
  if (
    file === "src/ui/webview-react/store/uiStore.ts" ||
    file === "src/ui/webview-react/utils/notifyUser.ts"
  ) {
    return true;
  }

  return (
    file === "src/ui/webview-react/hooks/useMessageHandler.ts" &&
    (isMessageHandlerAssignment(node, "NOTIFICATION_EVENT") ||
      isMessageHandlerAssignment(node, "USER_FEEDBACK"))
  );
}

interface ParsedProductionSource {
  sourceFile: ts.SourceFile;
  relativeFile: string;
}

/**
 * Parsing every production `.ts`/`.tsx` in the repository is by far the
 * expensive part of this file, and each of the cases below differs only in the
 * predicate it applies to the result. Parsing once and reusing the ASTs turns
 * three full-repo passes into one — which is what kept these cases inside the
 * suite's time budget under full-suite load.
 */
let parsedProductionSources:
  { repoRoot: string; sources: ParsedProductionSource[] } | undefined;

let orchestratorValueImportGraph:
  | { repoRoot: string; files: readonly ParsedProductionSource[] }
  | undefined;

function getParsedProductionSources(
  repoRoot: string
): ParsedProductionSource[] {
  if (parsedProductionSources?.repoRoot === repoRoot) {
    return parsedProductionSources.sources;
  }

  const sources = findProductionSourceFiles(repoRoot).map((filePath) => ({
    sourceFile: ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    ),
    relativeFile: path.relative(repoRoot, filePath).split(path.sep).join("/"),
  }));
  parsedProductionSources = { repoRoot, sources };
  return sources;
}

function resolveRelativeProductionImport(
  source: ParsedProductionSource,
  specifier: string,
  sourceByPath: ReadonlyMap<string, ParsedProductionSource>
): ParsedProductionSource | undefined {
  const basePath = path.resolve(
    path.dirname(source.sourceFile.fileName),
    specifier
  );
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];

  for (const candidate of candidates) {
    const resolved = sourceByPath.get(path.normalize(candidate));
    if (resolved) return resolved;
  }

  return undefined;
}

function isValueImport(node: ts.ImportDeclaration): boolean {
  const importClause = node.importClause;
  if (!importClause || !importClause.isTypeOnly) {
    if (
      importClause?.namedBindings &&
      ts.isNamedImports(importClause.namedBindings) &&
      importClause.namedBindings.elements.length > 0 &&
      importClause.namedBindings.elements.every(
        (specifier) => specifier.isTypeOnly
      )
    ) {
      return false;
    }
    return true;
  }

  return false;
}

function getOrchestratorValueImportGraph(
  repoRoot: string
): readonly ParsedProductionSource[] {
  if (orchestratorValueImportGraph?.repoRoot === repoRoot) {
    return orchestratorValueImportGraph.files;
  }

  const sources = getParsedProductionSources(repoRoot);
  const sourceByPath = new Map(
    sources.map((source) => [
      path.normalize(source.sourceFile.fileName),
      source,
    ])
  );
  const orchestrator = sources.find(
    (source) => source.relativeFile === "src/core/WorkflowOrchestrator.ts"
  );
  if (!orchestrator) {
    throw new Error("WorkflowOrchestrator.ts was not found");
  }

  const reachable = new Set<ParsedProductionSource>([orchestrator]);
  const pending = [orchestrator];
  while (pending.length > 0) {
    const source = pending.pop();
    if (!source) continue;
    const currentSource = source;

    function visit(node: ts.Node): void {
      if (
        ts.isImportDeclaration(node) &&
        isValueImport(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        const imported = resolveRelativeProductionImport(
          currentSource,
          node.moduleSpecifier.text,
          sourceByPath
        );
        if (imported && !reachable.has(imported)) {
          reachable.add(imported);
          pending.push(imported);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(source.sourceFile);
  }

  const files = [...reachable].sort((left, right) =>
    left.relativeFile.localeCompare(right.relativeFile)
  );
  orchestratorValueImportGraph = { repoRoot, files };
  return files;
}

function importsVscode(source: ParsedProductionSource): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "vscode"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source.sourceFile);
  return found;
}

function collectDirectVscodeImports(
  repoRoot: string,
  relativeFile: string
): number {
  const source = getParsedProductionSources(repoRoot).find(
    (candidate) => candidate.relativeFile === relativeFile
  );
  if (!source) throw new Error(`${relativeFile} was not found`);

  let count = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "vscode"
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source.sourceFile);
  return count;
}

function isVscodeOrExtensionContextType(type: ts.TypeNode): boolean {
  if (!ts.isTypeReferenceNode(type)) return false;

  const typeName = type.typeName;
  if (ts.isIdentifier(typeName)) {
    return typeName.text === "ExtensionContext";
  }

  return (
    ts.isQualifiedName(typeName) &&
    ts.isIdentifier(typeName.left) &&
    typeName.left.text === "vscode"
  );
}

function collectOrchestratorVsCodeConstructorParams(repoRoot: string): number {
  const source = getParsedProductionSources(repoRoot).find(
    (candidate) => candidate.relativeFile === "src/core/WorkflowOrchestrator.ts"
  );
  if (!source) throw new Error("WorkflowOrchestrator.ts was not found");

  let count = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isClassDeclaration(node) &&
      node.name?.text === "WorkflowOrchestrator"
    ) {
      for (const member of node.members) {
        if (!ts.isConstructorDeclaration(member)) continue;
        count += member.parameters.filter(
          (parameter) =>
            parameter.type !== undefined &&
            isVscodeOrExtensionContextType(parameter.type)
        ).length;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source.sourceFile);
  return count;
}

function collectCoreVsCodeAdapterConstructions(repoRoot: string): number {
  let count = 0;
  for (const source of getParsedProductionSources(repoRoot)) {
    if (!source.relativeFile.startsWith("src/core/")) continue;

    function visit(node: ts.Node): void {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "VsCodeAdapter"
      ) {
        count++;
      }
      ts.forEachChild(node, visit);
    }
    visit(source.sourceFile);
  }
  return count;
}

function collectCallSites(
  repoRoot: string,
  predicate: (node: ts.CallExpression) => boolean,
  includeCallSite: (
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    file: string
  ) => boolean = () => true
): SourceAuditSite[] {
  const sites: SourceAuditSite[] = [];

  for (const { sourceFile, relativeFile } of getParsedProductionSources(
    repoRoot
  )) {
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        predicate(node) &&
        includeCallSite(node, sourceFile, relativeFile)
      ) {
        sites.push({
          file: relativeFile,
          line:
            sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
              .line + 1,
          member: getPropertyAccessName(node.expression) ?? "unknown",
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return sites;
}

function assertShrinkOnlyCount(
  label: string,
  count: number,
  baseline: number,
  details = ""
): void {
  if (count > baseline) {
    throw new Error(
      `${label} count grew from ${baseline} to ${count}. ` + details
    );
  }

  if (count < baseline) {
    throw new Error(
      `${label} count shrank from ${baseline} to ${count}. ` +
        `Lower the committed baseline to ${count}.`
    );
  }
}

function assertShrinkOnly(
  label: string,
  sites: SourceAuditSite[],
  baseline: number
): void {
  if (sites.length > baseline) {
    const callSites = sites
      .map((site) => `- ${site.file}:${site.line} (${site.member})`)
      .join("\n");
    throw new Error(
      `${label} count grew from ${baseline} to ${sites.length}. ` +
        "New calls must go through the feedback path instead.\n" +
        `Call sites:\n${callSites}`
    );
  }

  if (sites.length < baseline) {
    throw new Error(
      `${label} count shrank from ${baseline} to ${sites.length}. ` +
        `Lower the committed baseline to ${sites.length}.`
    );
  }
}

suite("SourceAuditCounters", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");

  test("holds the orchestrator's transitive VS Code import graph baseline", function () {
    const reachableImporters = getOrchestratorValueImportGraph(repoRoot)
      .filter(importsVscode)
      .map((source) => source.relativeFile)
      .sort();

    assertShrinkOnlyCount(
      "Orchestrator transitive vscode-importer",
      reachableImporters.length,
      vscodeImportersReachableFromOrchestrator,
      "Update the baseline only when the owning phase removes an importer."
    );
    assert.deepStrictEqual(
      reachableImporters,
      vscodeImporterFilesReachableFromOrchestrator
    );
  });

  test("holds the orchestrator direct VS Code boundary baselines", function () {
    assertShrinkOnlyCount(
      "Orchestrator direct vscode import",
      collectDirectVscodeImports(repoRoot, "src/core/WorkflowOrchestrator.ts"),
      orchestratorDirectVsCodeImports
    );
    assertShrinkOnlyCount(
      "Orchestrator VS Code constructor parameter",
      collectOrchestratorVsCodeConstructorParams(repoRoot),
      orchestratorVsCodeConstructorParams
    );
  });

  test("holds the workflow instance direct VS Code import baseline", function () {
    assertShrinkOnlyCount(
      "WorkflowInstance direct vscode import",
      collectDirectVscodeImports(repoRoot, "src/core/WorkflowInstance.ts"),
      workflowInstanceDirectVsCodeImports
    );
  });

  test("holds the core VS Code adapter construction baseline", function () {
    assertShrinkOnlyCount(
      "Core VsCodeAdapter construction",
      collectCoreVsCodeAdapterConstructions(repoRoot),
      coreVsCodeAdapterConstructions
    );
  });

  test("holds the direct show*Message boundary and reusable baselines", function () {
    const sites = collectCallSites(repoRoot, isVscodeWindowMessageCall);
    const boundaryFiles =
      FEEDBACK_SOURCE_AUDIT_BASELINES.directMessage.boundaryFiles;
    const boundarySites = sites.filter((site) =>
      boundaryFiles.includes(site.file)
    );
    const reusableSites = sites.filter(
      (site) => !boundaryFiles.includes(site.file)
    );

    assertShrinkOnly(
      "VS Code boundary direct show*Message",
      boundarySites,
      FEEDBACK_SOURCE_AUDIT_BASELINES.directMessage.boundary
    );
    assertShrinkOnly(
      "Reusable direct show*Message",
      reusableSites,
      FEEDBACK_SOURCE_AUDIT_BASELINES.directMessage.reusable
    );
    assert.strictEqual(
      boundarySites.length + reusableSites.length,
      sites.length
    );
  });

  test("holds the adapter-mediated host UI baseline", function () {
    const sites = collectCallSites(repoRoot, isAdapterUiCall);
    assertShrinkOnly(
      "Adapter-mediated host UI",
      sites,
      FEEDBACK_SOURCE_AUDIT_BASELINES.adapterUi
    );
  });

  test("holds the host-aware webview toast baseline", function () {
    const sites = collectCallSites(
      repoRoot,
      isDirectToastCall,
      (_node, _sourceFile, file) =>
        file.startsWith("src/ui/webview-react/") &&
        !file.startsWith("src/ui/webview-react/test/") &&
        !isAllowedWebviewToastCall(_node, file)
    );
    assertShrinkOnly(
      "Unallowlisted webview showToast/enqueueToast",
      sites,
      FEEDBACK_SOURCE_AUDIT_BASELINES.webviewToast
    );
  });
});
