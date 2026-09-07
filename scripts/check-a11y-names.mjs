#!/usr/bin/env node
/**
 * Detect icon-only buttons that have no accessible name.
 *
 * jsx-a11y/control-has-associated-label cannot see that a codicon's glyph is
 * supplied by CSS at runtime. This source-level check catches the structural
 * shape before it reaches the browser, while leaving text-bearing controls to
 * the normal jsx-a11y rules.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const WEBVIEW_ROOT = path.join(PROJECT_ROOT, "src", "ui", "webview-react");
const TEST_PATH = /(?:^|[\\/])test(?:[\\/])|\.(?:test|spec)\.tsx?$/u;

function isTestPath(filePath, root) {
  const relativePath = path.relative(root, filePath);
  return TEST_PATH.test(relativePath);
}

function walkTsxFiles(directory, root, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkTsxFiles(absolutePath, root, files);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".tsx") &&
      !isTestPath(absolutePath, root)
    ) {
      files.push(absolutePath);
    }
  }
  return files;
}

function jsxNameText(name) {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function getAttribute(element, attributeName) {
  return element.attributes.properties.find(
    (attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.text === attributeName
  );
}

function getStaticString(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (
    ts.isJsxExpression(node) &&
    node.expression &&
    (ts.isStringLiteral(node.expression) ||
      ts.isNoSubstitutionTemplateLiteral(node.expression))
  ) {
    return node.expression.text;
  }
  return undefined;
}

function hasAccessibleNameAttribute(element) {
  return Boolean(
    getAttribute(element, "aria-label") ||
    getAttribute(element, "aria-labelledby")
  );
}

function isRoleButton(element) {
  const role = getAttribute(element, "role");
  return Boolean(
    role &&
    ts.isJsxAttribute(role) &&
    role.initializer &&
    getStaticString(role.initializer) === "button"
  );
}

function hasCodiconClass(element) {
  const className = getAttribute(element, "className");
  return className?.initializer
    ? (getStaticString(className.initializer)?.includes("codicon") ?? false)
    : false;
}

function isIconElement(node) {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) {
    return false;
  }
  const openingElement = ts.isJsxElement(node) ? node.openingElement : node;
  const name = openingElement.tagName;
  const nameText = jsxNameText(name);
  return (
    nameText === "Icon" ||
    nameText === "Codicon" ||
    ((nameText === "i" || nameText === "span") &&
      hasCodiconClass(openingElement))
  );
}

function isWhitespaceOnly(node) {
  return ts.isJsxText(node) && node.text.trim() === "";
}

function isEmptyJsxExpression(node) {
  return (
    ts.isJsxExpression(node) &&
    node.expression.kind === ts.SyntaxKind.JsxEmptyExpression
  );
}

function isIconOnly(element) {
  const children =
    element.parent && ts.isJsxElement(element.parent)
      ? element.parent.children
      : [];
  const meaningfulChildren = children.filter(
    (child) => !isWhitespaceOnly(child) && !isEmptyJsxExpression(child)
  );
  return (
    meaningfulChildren.length > 0 &&
    meaningfulChildren.every((child) => isIconElement(child))
  );
}

function toRelative(filePath, root = PROJECT_ROOT) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function collectFileViolations(filePath, violations, reportRoot) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const openingElement = ts.isJsxElement(node) ? node.openingElement : node;
      const name = jsxNameText(openingElement.tagName);
      const isButton = name === "button" || isRoleButton(openingElement);
      if (
        isButton &&
        !hasAccessibleNameAttribute(openingElement) &&
        ts.isJsxElement(node) &&
        isIconOnly(openingElement)
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          openingElement.getStart(sourceFile)
        );
        violations.push({
          location: `${toRelative(filePath, reportRoot)}:${line + 1}`,
          element: name === "button" ? "button" : 'role="button"',
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

/** Return icon-only buttons without aria-label/aria-labelledby in webview source. */
export function findA11yNameViolations({ srcRoot = WEBVIEW_ROOT } = {}) {
  const files = walkTsxFiles(srcRoot, srcRoot);
  const violations = [];
  for (const filePath of files)
    collectFileViolations(filePath, violations, srcRoot);
  return violations;
}

function run() {
  const violations = findA11yNameViolations();
  if (violations.length > 0) {
    console.error(
      "[a11y-name-guard] icon-only buttons without aria-label/aria-labelledby:"
    );
    for (const violation of violations) {
      console.error(`  - ${violation.location} (${violation.element})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    "[a11y-name-guard] no unnamed icon-only buttons found in webview source"
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
