import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const APPROVED_RAW_LOCK_FILES = new Set([
  "src/utils/WorkflowLockInspector.ts",
  "src/utils/WorkflowLockManager.ts",
]);

/**
 * Keep this allowlist intentionally small. The inspector owns parsing and
 * classification; the manager owns raw reads needed to mutate an exact lock.
 * This test is a cheap tripwire in addition to the nominal proof types.
 */
const ARCHITECTURE_SOURCE_ROOTS = [
  "src/core",
  "src/ui",
  "src/utils",
  "src/cli.ts",
];

suite("runner ownership architecture", () => {
  test("keeps ownership decisions behind structured lock infrastructure", () => {
    const sourceFiles = ARCHITECTURE_SOURCE_ROOTS.flatMap((relativeRoot) =>
      collectTypeScriptFiles(path.join(REPOSITORY_ROOT, relativeRoot))
    );

    for (const filePath of sourceFiles) {
      const relativePath = toRepositoryPath(filePath);
      const source = fs.readFileSync(filePath, "utf8");

      if (!APPROVED_RAW_LOCK_FILES.has(relativePath)) {
        assert.doesNotMatch(
          source,
          /\b(?:ACTIVE_VSCODE|ACTIVE_CLI|LOCK_STATUS)\b|active-vscode|active-cli/,
          `${relativePath} imports or interprets an obsolete runner lock status`
        );
        assert.doesNotMatch(
          source,
          /\breadWorkflowLock\b/,
          `${relativePath} bypasses WorkflowLockInspector for raw lock parsing`
        );
        assert.doesNotMatch(
          stripComments(source),
          /JSON\.parse[\s\S]{0,220}(?:runner\.json|runnerPath|runnerLockPath)/,
          `${relativePath} parses runner.json outside approved lock infrastructure`
        );
      }

      assert.doesNotMatch(
        source,
        /(?:managedBy|externalOwner)\s*:\s*(?:\{[^}]*runner\s*:\s*)?RUNNER_IDS\.VSCODE/,
        `${relativePath} maps RUNNER_IDS.VSCODE directly to external ownership`
      );
    }

    const watchCallSites = sourceFiles.filter((filePath) =>
      /new\s+ExternalRunWatchSession\s*\(/.test(
        fs.readFileSync(filePath, "utf8")
      )
    );
    assert.deepStrictEqual(
      watchCallSites.map(toRepositoryPath),
      ["src/core/WorkflowOrchestrator.ts"],
      "external watch sessions must have one production construction boundary"
    );

    const watchSessionSource = fs.readFileSync(
      path.join(
        REPOSITORY_ROOT,
        "src/core/orchestration/ExternalRunWatchSession.ts"
      ),
      "utf8"
    );
    assert.match(
      watchSessionSource,
      /inspection:\s*ActiveExternalLockInspection/,
      "external watch sessions must retain typed external-resolution proof"
    );

    const orchestratorSource = fs.readFileSync(
      path.join(REPOSITORY_ROOT, "src/core/WorkflowOrchestrator.ts"),
      "utf8"
    );
    assert.match(
      orchestratorSource,
      /new\s+ExternalRunWatchSession[\s\S]*?currentInspection/,
      "the watch construction must use the resolver's revalidated inspection"
    );
  });
});

function collectTypeScriptFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) return [];
  const stats = fs.statSync(rootPath);
  if (stats.isFile()) return rootPath.endsWith(".ts") ? [rootPath] : [];

  return fs
    .readdirSync(rootPath, { withFileTypes: true })
    .flatMap((entry) =>
      collectTypeScriptFiles(path.join(rootPath, entry.name))
    );
}

function toRepositoryPath(filePath: string): string {
  return path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join("/");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}
