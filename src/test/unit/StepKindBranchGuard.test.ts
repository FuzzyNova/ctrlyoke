import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { suite, test } from "mocha";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");

type AllowedBranch = { file: string; reason: string };

// Keep only branches whose purpose really is script versus every other kind.
// The file key includes a stable function name or normalized code excerpt.
const ALLOWED_BRANCHES: readonly AllowedBranch[] = [
  {
    file: "src/cli/CliJsonResultBuilder.ts#buildStepResult: isScriptStep(step)",
    reason:
      "This optional JSON property contains only script execution output.",
  },
  {
    file: "src/cli/CliJsonResultBuilder.ts#buildFinalStep: isScriptStep(step)",
    reason:
      "This optional JSON property contains only script execution output.",
  },
  {
    file: "src/cli/CliJsonResultBuilder.ts#buildFinalPass: isScriptStep(step)",
    reason:
      "This optional JSON property contains only script execution output.",
  },
];

type Branch = { key: string; file: string; excerpt: string };

function isScriptStepCall(node: ts.Expression): boolean {
  const expression = unwrap(node);
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "isScriptStep"
  );
}

function comparesScriptType(node: ts.Expression): boolean {
  const expression = unwrap(node);
  if (!ts.isBinaryExpression(expression)) return false;
  if (
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    expression.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return false;
  }
  return [expression.left, expression.right].some((side) =>
    isScriptTypeReference(side)
  );
}

function isScriptTypeReference(node: ts.Expression): boolean {
  const expression = unwrap(node);
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "SCRIPT" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "STEP_TYPES"
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isTargetCondition(node: ts.Expression): boolean {
  return isScriptStepCall(node) || comparesScriptType(node);
}

function collectBranches(sourceText: string, file: string): Branch[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const branches: Branch[] = [];

  function visit(node: ts.Node, enclosingName: string): void {
    let name = enclosingName;
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      name = node.name.text;
    }

    if (ts.isConditionalExpression(node) && isTargetCondition(node.condition)) {
      const excerpt = node.condition.getText(source);
      branches.push({
        file: `${file}#${name}: ${excerpt}`,
        key: `${file}#${name}: ${excerpt}`,
        excerpt: node.getText(source).slice(0, 100),
      });
    } else if (
      ts.isIfStatement(node) &&
      node.elseStatement &&
      isTargetCondition(node.expression)
    ) {
      const excerpt = node.expression.getText(source);
      branches.push({
        file: `${file}#${name}: ${excerpt}`,
        key: `${file}#${name}: ${excerpt}`,
        excerpt: node.getText(source).slice(0, 100),
      });
    }

    ts.forEachChild(node, (child) => visit(child, name));
  }

  visit(source, "<top-level>");
  return branches;
}

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(filePath);
    if (
      !entry.isFile() ||
      !/\.tsx?$/.test(entry.name) ||
      /\.(?:test|spec)\.tsx?$/.test(entry.name) ||
      filePath.split(path.sep).includes("test")
    ) {
      return [];
    }
    return [filePath];
  });
}

function findBranches(sourceText: string): Branch[] {
  return collectBranches(sourceText, "synthetic.ts");
}

suite("step-kind branching guard", () => {
  test("flags a binary type guard and accepts an exhaustive switch", () => {
    assert.strictEqual(
      findBranches("const value = isScriptStep(s) ? a : b;").length,
      1
    );
    assert.strictEqual(
      findBranches(
        "switch (getStepType(s)) { case STEP_TYPES.SCRIPT: break; case STEP_TYPES.PROMPT: break; default: assertNever(getStepType(s)); }"
      ).length,
      0
    );
  });

  test("keeps prohibited branches out of production sources", () => {
    const branches = collectTypeScriptFiles(
      path.join(REPOSITORY_ROOT, "src")
    ).flatMap((filePath) => {
      const relativePath = path
        .relative(REPOSITORY_ROOT, filePath)
        .split(path.sep)
        .join("/");
      return collectBranches(fs.readFileSync(filePath, "utf8"), relativePath);
    });
    const allowedKeys = new Set(ALLOWED_BRANCHES.map(({ file }) => file));
    const foundKeys = new Set(branches.map(({ key }) => key));
    const unexpected = branches.filter(({ key }) => !allowedKeys.has(key));
    const stale = ALLOWED_BRANCHES.filter(({ file }) => !foundKeys.has(file));

    assert.deepStrictEqual(
      unexpected.map(({ file, excerpt }) => `${file}: ${excerpt}`),
      [],
      "Use an exhaustive getStepType switch or isPromptStep for binary step-kind branches"
    );
    assert.deepStrictEqual(
      stale.map(({ file }) => file),
      [],
      "Remove allow-list entries when their matching branch no longer exists"
    );
  });
});
