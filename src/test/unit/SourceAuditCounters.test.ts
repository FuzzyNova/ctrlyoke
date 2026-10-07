import * as assert from "assert";
import * as fs from "fs";
import { builtinModules } from "module";
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
    // Shrank from 46 to 41: Stage 3b removed five router worktree notices;
    // routine success notices were dropped and failures now use scoped replies.
    boundary: 41,
    reusable: 0,
    boundaryFiles: [
      "src/completions/ContextMenuReferenceCommands.ts",
      "src/dev/DevCommands.ts",
      "src/extension.ts",
      "src/platform/VsCodeAdapter.ts",
      "src/scm/ScmCommitCommand.ts",
      "src/ui/ExternalFileTrustPrompt.ts",
      "src/ui/NotificationManager.ts",
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
// Shrunk from 8 to 4 when the CLI runtime graph was decoupled, from 4 to 2 by
// moving both watcher sessions behind FileWatcherFactory, then to 0 by
// extracting host actions and external-root approvals.
const vscodeImportersReachableFromOrchestrator = 0;

const vscodeImporterFilesReachableFromOrchestrator = [] as const;

// Phase 1 item 9 removes the orchestrator's direct vscode import.
const orchestratorDirectVsCodeImports = 0;

// Shrunk from 1 to 0: the orchestrator now accepts project-owned dependencies
// instead of a VS Code ExtensionContext constructor parameter.
const orchestratorVsCodeConstructorParams = 0;

// Already clean; this guard prevents WorkflowInstance.ts from regressing.
const workflowInstanceDirectVsCodeImports = 0;

// TemplateManager now receives the extension path and injected platform.
const coreVsCodeAdapterConstructions = 0;

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

interface ValueImportGraph {
  /** Production sources reachable through runtime (non-type) edges. */
  files: readonly ParsedProductionSource[];
  /** Bare (package) specifiers imported at runtime anywhere in the graph. */
  packageSpecifiers: readonly string[];
}

const valueImportGraphs = new Map<string, ValueImportGraph>();

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

/**
 * The module specifier of a runtime import edge — a value `import`, a value
 * `export … from`, or a dynamic `import()` — or `undefined` for any other
 * node, including type-only imports and re-exports, which are erased.
 */
function getRuntimeImportSpecifier(node: ts.Node): string | undefined {
  if (
    ts.isImportDeclaration(node) &&
    isValueImport(node) &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(node) &&
    !node.isTypeOnly &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

function getValueImportGraph(
  repoRoot: string,
  entryRelativeFile: string
): ValueImportGraph {
  const cacheKey = `${repoRoot}\0${entryRelativeFile}`;
  const cached = valueImportGraphs.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sources = getParsedProductionSources(repoRoot);
  const sourceByPath = new Map(
    sources.map((source) => [
      path.normalize(source.sourceFile.fileName),
      source,
    ])
  );
  const entry = sources.find(
    (source) => source.relativeFile === entryRelativeFile
  );
  if (!entry) {
    throw new Error(`${entryRelativeFile} was not found`);
  }

  const reachable = new Set<ParsedProductionSource>([entry]);
  const packageSpecifiers = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const source = pending.pop();
    if (!source) continue;
    const currentSource = source;

    function visit(node: ts.Node): void {
      const specifier = getRuntimeImportSpecifier(node);
      if (specifier?.startsWith(".")) {
        const imported = resolveRelativeProductionImport(
          currentSource,
          specifier,
          sourceByPath
        );
        if (imported && !reachable.has(imported)) {
          reachable.add(imported);
          pending.push(imported);
        }
      } else if (specifier) {
        packageSpecifiers.add(specifier);
      }
      ts.forEachChild(node, visit);
    }

    visit(source.sourceFile);
  }

  const graph: ValueImportGraph = {
    files: [...reachable].sort((left, right) =>
      left.relativeFile.localeCompare(right.relativeFile)
    ),
    packageSpecifiers: [...packageSpecifiers].sort(),
  };
  valueImportGraphs.set(cacheKey, graph);
  return graph;
}

function getOrchestratorValueImportGraph(
  repoRoot: string
): readonly ParsedProductionSource[] {
  return getValueImportGraph(repoRoot, "src/core/WorkflowOrchestrator.ts")
    .files;
}

const NODE_BUILTIN_MODULES = new Set(builtinModules);

function isNodeBuiltinSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    NODE_BUILTIN_MODULES.has(specifier.split("/")[0])
  );
}

/**
 * Walk the installed JavaScript that `packageSpecifier` loads through static
 * `require()` calls and return the chain to the first `require("vscode")`,
 * or `undefined` when the package never loads it. Packages such as
 * `@vscode/extension-telemetry` require `vscode` internally, which no
 * source-level import scan can see.
 */
function findPackageVscodeRequireChain(
  repoRoot: string,
  packageSpecifier: string
): string[] | undefined {
  let entry: string;
  try {
    entry = require.resolve(packageSpecifier, { paths: [repoRoot] });
  } catch {
    // Not installed (e.g. an optional native dependency); nothing to walk.
    return undefined;
  }

  const parents = new Map<string, string | undefined>([[entry, undefined]]);
  const pending = [entry];
  const requirePattern = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    for (let at: string | undefined = file; at; at = parents.get(at)) {
      chain.unshift(path.relative(repoRoot, at).split(path.sep).join("/"));
    }
    return [packageSpecifier, ...chain];
  };

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || !/\.c?js$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(requirePattern)) {
      const required = match[1];
      if (required === "vscode") {
        return chainTo(file);
      }
      if (isNodeBuiltinSpecifier(required)) continue;
      let resolved: string;
      try {
        resolved = require.resolve(required, { paths: [path.dirname(file)] });
      } catch {
        continue;
      }
      if (!parents.has(resolved)) {
        parents.set(resolved, file);
        pending.push(resolved);
      }
    }
  }
  return undefined;
}

/**
 * Every way the runtime graph rooted at `entryRelativeFile` loads `vscode`:
 * project files that import it, and packages that require it internally.
 */
function collectVscodeLoadsReachableFrom(
  repoRoot: string,
  entryRelativeFile: string
): string[] {
  const graph = getValueImportGraph(repoRoot, entryRelativeFile);
  const loads = graph.files
    .filter(importsVscode)
    .map((source) => source.relativeFile);
  for (const specifier of graph.packageSpecifiers) {
    if (specifier === "vscode" || isNodeBuiltinSpecifier(specifier)) continue;
    const chain = findPackageVscodeRequireChain(repoRoot, specifier);
    if (chain) {
      loads.push(chain.join(" -> "));
    }
  }
  return loads.sort();
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
    // This parses the full production TypeScript import graph while the other
    // extension shards and UI suite run alongside it.
    this.timeout(60_000);
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

  for (const entry of ["src/cli.ts", "src/mcp-server.ts"]) {
    test(`${entry} never loads vscode at runtime`, function () {
      // Shares the parsed-source cache with the orchestrator graph test, but
      // also walks installed package JavaScript.
      this.timeout(60_000);
      // The same entry is also run from plain `tsc` output (compile-tests
      // emits it first), where any reachable `vscode` load is a hard crash:
      // "Cannot find module 'vscode'". The standalone binaries must not
      // depend on VS Code at all.
      assert.deepStrictEqual(
        collectVscodeLoadsReachableFrom(repoRoot, entry),
        [],
        `${entry} reaches code that loads vscode. Move the VS Code-specific ` +
          "part behind a host port implemented under src/platform/ and wired " +
          "from extension.ts."
      );
    });
  }

  for (const entry of [
    "src/ui/DashboardApplication.ts",
    "src/server/CtrlYokeHostedServer.ts",
    "src/platform/NodeHostServices.ts",
    "src/cli/ServerCommand.ts",
  ]) {
    test(`${entry} never loads vscode at runtime`, function () {
      this.timeout(60_000);
      assert.deepStrictEqual(
        collectVscodeLoadsReachableFrom(repoRoot, entry),
        [],
        `${entry} reaches code that loads vscode. Keep the shared dashboard application and server host-neutral.`
      );
    });
  }

  test("PromptEditorSupportService never loads vscode at runtime", function () {
    this.timeout(60_000);
    assert.deepStrictEqual(
      collectVscodeLoadsReachableFrom(
        repoRoot,
        "src/ui/PromptEditorSupportService.ts"
      ),
      [],
      "PromptEditorSupportService reaches code that loads vscode. Keep completions behind injected host ports."
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

  test("shared UI services stay outside the VS Code boundary", function () {
    for (const file of [
      "src/ui/WorkflowSerializer.ts",
      "src/ui/WebviewSettingsSync.ts",
      "src/ui/PromptEditorSupportService.ts",
      "src/ui/HarnessFileMessageService.ts",
    ]) {
      const source = getParsedProductionSources(repoRoot).find(
        (candidate) => candidate.relativeFile === file
      );
      assert.ok(source, `${file} was not found`);
      const forbidden: string[] = [];
      function visit(node: ts.Node): void {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          (node.moduleSpecifier.text === "vscode" ||
            node.moduleSpecifier.text.endsWith("VsCodeWorkspaceRoot"))
        ) {
          forbidden.push(node.moduleSpecifier.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source.sourceFile);
      assert.deepStrictEqual(
        forbidden,
        [],
        `${file} imports a VS Code boundary`
      );
    }
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
