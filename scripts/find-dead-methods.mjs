#!/usr/bin/env node
/**
 * Dead class-method finder.
 *
 * knip (and ts-prune/ts-unused-exports) only analyze module-level exports —
 * they mark a class "used" the moment anything imports it, then never look
 * inside at whether individual methods are actually called. A public method
 * on an otherwise-live class can sit with zero callers forever and none of
 * those tools will flag it (see EndConditionHandler.handleExecutionError,
 * deleted 2026-07-29, for a real example this script is built to catch).
 *
 * This script walks every class/method declaration reachable from BOTH the
 * root tsconfig.json (extension host, core engine, CLI/MCP binaries, harness
 * code, tests) and src/ui/webview-react/tsconfig.json (the React dashboard),
 * combined into a single TypeScript program. Repository scripts are also
 * checked as reference sources: TypeScript references handle statically typed
 * calls, and a narrow ClassName.method() / .method() text check catches calls
 * hidden behind dynamic CommonJS requires. Production methods can be called
 * from docs/build/maintenance scripts outside both tsconfigs. The language
 * service's findReferences (the same engine behind VS Code "Find All
 * References") counts non-declaration usages. Anything at zero is reported
 * as a dead-method candidate.
 *
 * Why both projects have to be combined into one program: the webview
 * imports directly from extension-side directories via path aliases
 * (`@root/types/*` -> src/types, `@root/utils/*` -> src/utils,
 * `@root/completions/*` -> src/completions — see
 * src/ui/webview-react/tsconfig.json). A method that looks unused when only
 * the root tsconfig's files are scanned can be called exclusively from
 * webview code, and vice versa (a small number of webview classes — React
 * error-boundary components in particular — could in principle be imported
 * back into extension-side code that renders a static HTML shell). Two
 * separate language-service instances, one per tsconfig, cannot see each
 * other's call sites, so this script builds one merged program instead. This
 * mirrors why knip.json has to manually list files like
 * WebviewMessageTypes.ts and CtrlYokeTypes.ts as "entry" points — the same
 * cross-project blind spot, worked around there instead of fixed.
 *
 * False-positive reduction:
 *  - Skips methods with no body (abstract/ambient).
 *  - Skips methods whose containing class `implements` OR `extends` a
 *    type that declares a same-named member, since the language service
 *    resolves calls through an interface/base-class-typed variable (or a
 *    framework's own runtime dispatch, e.g. React calling `render()` /
 *    `componentDidCatch()` on a class extending `Component`) to that type's
 *    symbol, not the subclass's override symbol, and undercounts them.
 *  - Skips a small fixed list of duck-typed lifecycle/magic method names
 *    (dispose, toString, toJSON, React lifecycle hooks, etc.) that get
 *    called reflectively by frameworks rather than by direct reference.
 *  - Skips methods with a leading `@keep` JSDoc/comment tag as a manual
 *    escape hatch.
 *
 * Two reported categories, because they need different judgements:
 *  - **Unreferenced** — zero non-declaration references anywhere. Almost
 *    always deletable once the false-positive checks above are ruled out.
 *  - **Test-only** — a method declared in production code whose only
 *    references are in test files. The reference count is above zero, so the
 *    unreferenced check structurally cannot see it. This is either a
 *    legitimate seam (a hook or utility that exists so production behaviour
 *    can be tested) or a method orphaned by a refactor whose own tests kept
 *    it looking alive — `WorkingFileManager.seedDraftFromRun` was the latter,
 *    invisible here for weeks between RUN_HEAD_MUTABILITY phase 2 removing
 *    its only caller and its deletion on 2026-08-16. Methods *declared* in
 *    test files are excluded: test code calling test code is not a finding,
 *    and a wholly unused test helper already shows up as unreferenced.
 *
 * This is a heuristic triage tool, not a source of truth: every reported
 * candidate still needs a human (or agent) to verify before deleting, the
 * same way the EndConditionHandler case was independently re-verified
 * before deletion rather than trusting a backlog doc.
 *
 * Usage: node scripts/find-dead-methods.mjs [--json]
 */

import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ROOT_TSCONFIG_PATH = path.join(ROOT, "tsconfig.json");
const WEBVIEW_ROOT = path.join(ROOT, "src", "ui", "webview-react");
const WEBVIEW_TSCONFIG_PATH = path.join(WEBVIEW_ROOT, "tsconfig.json");

const IGNORED_METHOD_NAMES = new Set([
  "constructor",
  "dispose",
  "toString",
  "toJSON",
  "valueOf",
  "activate",
  "deactivate",
  // React class-component lifecycle: invoked by the React runtime via
  // prototype dispatch, never by a direct call the language service can see.
  "render",
  "componentDidMount",
  "componentDidUpdate",
  "componentWillUnmount",
  "shouldComponentUpdate",
  "getSnapshotBeforeUpdate",
  "componentDidCatch",
  "getDerivedStateFromError",
  "getDerivedStateFromProps",
]);

const KEEP_TAG = "@keep";

function readRepositoryScriptSources() {
  return ts.sys
    .readDirectory(path.join(ROOT, "scripts"), [".mjs", ".js", ".ts"])
    .map((fileName) => ts.sys.readFile(fileName) ?? "");
}

function hasRepositoryScriptReference(candidate, scriptSources) {
  const escapedClassName = candidate.className.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const escapedMethodName = candidate.methodName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const classQualifiedCall = new RegExp(
    `\\b${escapedClassName}\\s*\\.\\s*${escapedMethodName}\\s*\\(`
  );
  const methodCall = new RegExp(`\\.\\s*${escapedMethodName}\\s*\\(`);
  return scriptSources.some(
    (source) => classQualifiedCall.test(source) || methodCall.test(source)
  );
}

function parseTsconfig(configPath, basePath) {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")
    );
  }
  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, basePath);
}

function loadCombinedProjectConfig() {
  const root = parseTsconfig(ROOT_TSCONFIG_PATH, ROOT);
  const webview = parseTsconfig(WEBVIEW_TSCONFIG_PATH, WEBVIEW_ROOT);

  const fileNames = [...new Set([...root.fileNames, ...webview.fileNames])];
  const scriptFileNames = ts.sys.readDirectory(
    path.join(ROOT, "scripts"),
    [".mjs", ".js", ".ts"]
  );
  fileNames.push(
    ...scriptFileNames.filter((fileName) => !fileNames.includes(fileName))
  );

  // Base the merged options on the webview config (it carries the `paths`
  // aliases and their base path) and widen `lib`/`target` to a superset that
  // satisfies both the Node-side (root) and DOM-side (webview) files. This is
  // a best-effort merge for reference-finding, not a real build config —
  // spurious type diagnostics from mixing Node/DOM globals across the
  // combined program are expected and irrelevant to symbol resolution.
  const options = {
    ...webview.options,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
  };

  return { fileNames, options };
}

function createLanguageService({ fileNames, options }) {
  const host = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      if (!ts.sys.fileExists(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(ts.sys.readFile(fileName) ?? "");
    },
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function hasKeepTag(node, sourceFile) {
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges) return false;
  return ranges.some((r) => fullText.slice(r.pos, r.end).includes(KEEP_TAG));
}

function heritageDeclaresMemberName(classNode, memberName, checker) {
  if (!classNode.heritageClauses) return false;
  for (const clause of classNode.heritageClauses) {
    // Check both `implements X` and `extends Base` — a method can be an
    // interface implementation OR a base-class/framework override.
    for (const typeExpr of clause.types) {
      const type = checker.getTypeAtLocation(typeExpr);
      const member = checker.getPropertyOfType(type, memberName);
      if (member) return true;
    }
  }
  return false;
}

function collectMethodCandidates(sourceFile, checker) {
  const candidates = [];

  function visitClass(classNode) {
    const className = classNode.name?.text ?? "<anonymous>";
    for (const member of classNode.members) {
      const isMethod = ts.isMethodDeclaration(member);
      const isAccessor =
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member);
      if (!isMethod && !isAccessor) continue;
      if (!member.body) continue; // abstract/ambient
      if (!member.name || !ts.isIdentifier(member.name)) continue; // skip computed names

      const methodName = member.name.text;
      if (IGNORED_METHOD_NAMES.has(methodName)) continue;
      if (hasKeepTag(member, sourceFile)) continue;
      if (heritageDeclaresMemberName(classNode, methodName, checker)) continue;

      candidates.push({
        className,
        methodName,
        fileName: sourceFile.fileName,
        pos: member.name.getStart(sourceFile),
        line:
          sourceFile.getLineAndCharacterOfPosition(
            member.name.getStart(sourceFile)
          ).line + 1,
      });
    }
  }

  function visit(node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitClass(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return candidates;
}

function isSameDeclarationEntry(entry, candidate) {
  return (
    path.resolve(entry.fileName) === path.resolve(candidate.fileName) &&
    entry.textSpan.start === candidate.pos
  );
}

/**
 * Test code: the two test roots plus any `*.test.*` / `*.spec.*` file. Test
 * helpers under `src/test/integration/helpers/` are deliberately included —
 * a production method reached only through a test helper is still reached only
 * by tests, and collapsing that indirection is the entire point of the
 * test-only category.
 */
function isTestFile(fileName) {
  const resolved = path.resolve(fileName);
  const relative = path.relative(ROOT, resolved).split(path.sep).join("/");
  return (
    relative.startsWith("src/test/") ||
    relative.startsWith("src/ui/webview-react/test/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)
  );
}

function main() {
  const jsonOutput = process.argv.includes("--json");
  const projectConfig = loadCombinedProjectConfig();
  const scriptSources = readRepositoryScriptSources();
  const service = createLanguageService(projectConfig);
  const program = service.getProgram();
  if (!program) throw new Error("Failed to build TypeScript program");
  const checker = program.getTypeChecker();

  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile &&
        path
          .resolve(sf.fileName)
          .startsWith(path.resolve(ROOT, "src") + path.sep)
    );

  let candidateCount = 0;
  const deadMethods = [];
  const testOnlyMethods = [];

  for (const sourceFile of sourceFiles) {
    const declaredInTest = isTestFile(sourceFile.fileName);
    const candidates = collectMethodCandidates(sourceFile, checker);
    for (const candidate of candidates) {
      candidateCount++;
      const refs = service.findReferences(candidate.fileName, candidate.pos);
      let externalRefCount = 0;
      let productionRefCount = 0;
      for (const refSymbol of refs ?? []) {
        for (const entry of refSymbol.references) {
          if (isSameDeclarationEntry(entry, candidate)) continue;
          externalRefCount++;
          if (!isTestFile(entry.fileName)) productionRefCount++;
        }
      }
      if (hasRepositoryScriptReference(candidate, scriptSources)) {
        externalRefCount++;
        productionRefCount++;
      }

      const record = {
        location: `${path.relative(ROOT, candidate.fileName)}:${candidate.line}`,
        className: candidate.className,
        methodName: candidate.methodName,
      };

      if (externalRefCount === 0) {
        deadMethods.push({ ...record, category: "unreferenced" });
      } else if (productionRefCount === 0 && !declaredInTest) {
        // Production declaration whose only callers are tests. Not necessarily
        // dead — a hook or utility that exists to make production behaviour
        // testable is legitimate — but it is the shape that hides a method
        // orphaned by a refactor, since its own tests keep the reference count
        // above zero. Reported separately so the judgement can be made.
        testOnlyMethods.push({
          ...record,
          category: "test-only",
          testRefCount: externalRefCount,
        });
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify([...deadMethods, ...testOnlyMethods], null, 2));
    return;
  }

  console.log(
    `Scanned ${sourceFiles.length} candidate files (extension + webview, combined program; ` +
      `repository scripts are reference sources), ` +
      `${candidateCount} class-method candidates.\n`
  );

  if (deadMethods.length === 0) {
    console.log("No zero-reference class methods found.\n");
  } else {
    console.log(`${deadMethods.length} candidate(s) with zero references:\n`);
    for (const m of deadMethods) {
      console.log(`  ${m.location}  ${m.className}.${m.methodName}()`);
    }
    console.log(
      "\nThese are heuristic candidates, not confirmed dead code — verify each one " +
        "(check for dynamic dispatch, reflection, interface implementations this " +
        "script may have missed) before deleting.\n"
    );
  }

  if (testOnlyMethods.length > 0) {
    console.log(
      `${testOnlyMethods.length} candidate(s) referenced ONLY by tests:\n`
    );
    for (const m of testOnlyMethods) {
      const plural = m.testRefCount === 1 ? "" : "s";
      console.log(
        `  ${m.location}  ${m.className}.${m.methodName}()  ` +
          `(${m.testRefCount} test reference${plural})`
      );
    }
    console.log(
      "\nThese are production methods with no production caller — their only " +
        "references are in test code, so the zero-reference check above cannot " +
        "see them. Two very different things look identical here, so decide " +
        "per method:\n" +
        "  - Legitimate: a hook, seam, or utility that exists so production " +
        "behaviour can be tested, or one other tests depend on.\n" +
        "  - Dead: a method whose production caller was removed by a refactor " +
        "while its own unit tests stayed behind (see WorkingFileManager." +
        "seedDraftFromRun, deleted 2026-08-16 — orphaned by RUN_HEAD_MUTABILITY " +
        "phase 2, hidden from this script for weeks by its own passing tests).\n" +
        "Deleting a genuinely dead one means deleting its tests too; they are " +
        "not coverage of anything shipped."
    );
  }
}

main();
