import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { suite, test } from "mocha";

export const FEEDBACK_SOURCE_AUDIT_BASELINES = {
  directMessage: {
    boundary: 53,
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

  for (const filePath of findProductionSourceFiles(repoRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const relativeFile = path
      .relative(repoRoot, filePath)
      .split(path.sep)
      .join("/");

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

suite("source audit counters", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");

  test("holds the direct show*Message boundary and reusable baselines", function () {
    // Full-repo TypeScript AST parse; default 2000ms mocha timeout is too
    // tight under CPU contention (e.g. running as a ctrlyoke script step
    // while the extension host is also busy orchestrating the workflow).
    this.timeout(10_000);
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
    this.timeout(10_000);
    const sites = collectCallSites(repoRoot, isAdapterUiCall);
    assertShrinkOnly(
      "Adapter-mediated host UI",
      sites,
      FEEDBACK_SOURCE_AUDIT_BASELINES.adapterUi
    );
  });

  test("holds the host-aware webview toast baseline", function () {
    this.timeout(10_000);
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
