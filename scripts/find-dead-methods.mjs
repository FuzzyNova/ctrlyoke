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
 * combined into a single TypeScript program, and uses the language service's
 * findReferences (the same engine behind VS Code "Find All References") to
 * count non-declaration usages. Anything at zero is reported as a dead-method
 * candidate.
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
        ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
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
        line: sourceFile.getLineAndCharacterOfPosition(member.name.getStart(sourceFile)).line + 1,
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

function main() {
  const jsonOutput = process.argv.includes("--json");
  const projectConfig = loadCombinedProjectConfig();
  const service = createLanguageService(projectConfig);
  const program = service.getProgram();
  if (!program) throw new Error("Failed to build TypeScript program");
  const checker = program.getTypeChecker();

  const sourceFiles = program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile &&
        path.resolve(sf.fileName).startsWith(path.resolve(ROOT, "src") + path.sep)
    );

  let candidateCount = 0;
  const deadMethods = [];

  for (const sourceFile of sourceFiles) {
    const candidates = collectMethodCandidates(sourceFile, checker);
    for (const candidate of candidates) {
      candidateCount++;
      const refs = service.findReferences(candidate.fileName, candidate.pos);
      let externalRefCount = 0;
      if (refs) {
        for (const refSymbol of refs) {
          for (const entry of refSymbol.references) {
            if (!isSameDeclarationEntry(entry, candidate)) {
              externalRefCount++;
            }
          }
        }
      }
      if (externalRefCount === 0) {
        deadMethods.push({
          location: `${path.relative(ROOT, candidate.fileName)}:${candidate.line}`,
          className: candidate.className,
          methodName: candidate.methodName,
        });
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(deadMethods, null, 2));
    return;
  }

  console.log(
    `Scanned ${sourceFiles.length} files (extension + webview, combined program), ` +
      `${candidateCount} class-method candidates.\n`
  );
  if (deadMethods.length === 0) {
    console.log("No zero-reference class methods found.");
    return;
  }
  console.log(`${deadMethods.length} candidate(s) with zero references:\n`);
  for (const m of deadMethods) {
    console.log(`  ${m.location}  ${m.className}.${m.methodName}()`);
  }
  console.log(
    "\nThese are heuristic candidates, not confirmed dead code — verify each one " +
      "(check for dynamic dispatch, reflection, interface implementations this " +
      "script may have missed) before deleting."
  );
}

main();
