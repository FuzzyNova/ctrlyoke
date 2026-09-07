#!/usr/bin/env node
/**
 * One-shot migration tool: rewrite unambiguous raw codicon JSX elements to
 * the shared Icon component. It is intentionally not wired into precompile
 * or any npm lifecycle script.
 *
 * Usage:
 *   node scripts/codemod-codicon-icon.mjs <directory-or-glob> [...]
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const SHARED_COMPONENT_DIR = path.resolve(
  REPO_ROOT,
  "src/ui/webview-react/components/shared"
);
const JSX_EXTENSIONS = new Set([".tsx", ".jsx"]);
const NON_ICON_CODICON_CLASSES = new Set([
  "codicon-modifier-spin",
  "codicon-sm",
  "codicon-lg",
  "codicon-xl",
]);

function usage() {
  console.error(
    "Usage: node scripts/codemod-codicon-icon.mjs <directory-or-glob> [...]"
  );
  process.exit(1);
}

function isJsxFile(filePath) {
  return JSX_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else if (entry.isFile() && isJsxFile(entryPath)) files.push(entryPath);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern) {
  const normalized = pattern.split(path.sep).join("/");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`^${expression}$`, "i");
}

function collectFiles(argument) {
  const absoluteArgument = path.resolve(REPO_ROOT, argument);
  if (fs.existsSync(absoluteArgument)) {
    const stats = fs.statSync(absoluteArgument);
    if (stats.isDirectory()) return walk(absoluteArgument);
    return isJsxFile(absoluteArgument) ? [absoluteArgument] : [];
  }

  const normalizedPattern = path
    .resolve(REPO_ROOT, argument)
    .split(path.sep)
    .join("/");
  const wildcardIndex = normalizedPattern.search(/[?*]/);
  const root =
    wildcardIndex === -1
      ? REPO_ROOT
      : normalizedPattern.slice(
          0,
          normalizedPattern.lastIndexOf("/", wildcardIndex)
        );
  const rootDirectory = root || path.parse(normalizedPattern).root;
  const matcher = globToRegExp(normalizedPattern);
  return walk(rootDirectory).filter((filePath) =>
    matcher.test(filePath.split(path.sep).join("/"))
  );
}

function readBracedValue(source, start) {
  let braceDepth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") braceDepth += 1;
    if (character === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parseAttributes(tagSource, tagName) {
  const attributes = [];
  const body = tagSource.slice(1 + tagName.length, -2);
  let index = 0;
  while (index < body.length) {
    while (/\s/.test(body[index] ?? "")) index += 1;
    if (index >= body.length) break;
    if (body[index] === "{") return null;
    const nameStart = index;
    while (/[A-Za-z0-9:_-]/.test(body[index] ?? "")) index += 1;
    if (nameStart === index) return null;
    const name = body.slice(nameStart, index);
    while (/\s/.test(body[index] ?? "")) index += 1;
    let value = null;
    if (body[index] === "=") {
      index += 1;
      while (/\s/.test(body[index] ?? "")) index += 1;
      if (body[index] === '"' || body[index] === "'") {
        const quote = body[index];
        const valueStart = index;
        index += 1;
        while (index < body.length && body[index] !== quote) index += 1;
        if (index >= body.length) return null;
        index += 1;
        value = body.slice(valueStart, index);
      } else if (body[index] === "{") {
        value = readBracedValue(body, index);
        if (!value) return null;
        index += value.length;
      } else {
        return null;
      }
    }
    attributes.push({ name, value });
  }
  return attributes;
}

function unwrapAttributeValue(value, expected) {
  if (!value) return null;
  if (value.startsWith(expected) && value.endsWith(expected)) {
    return value.slice(1, -1);
  }
  return null;
}

function makeClassNameAttribute(value) {
  if (!value) return "";
  if (!value.includes("${")) return ` className="${value}"`;
  return ` className={\`${value}\`}`;
}

function parseIconClass(value) {
  const expressionValue =
    value?.startsWith("{") && value.endsWith("}")
      ? value.slice(1, -1).trim()
      : value;
  const staticClasses =
    unwrapAttributeValue(expressionValue, '"') ??
    unwrapAttributeValue(expressionValue, "'");
  if (staticClasses !== null) {
    const classes = staticClasses.trim().split(/\s+/).filter(Boolean);
    if (!classes.includes("codicon")) return null;
    const names = classes.filter(
      (className) =>
        className.startsWith("codicon-") &&
        !NON_ICON_CODICON_CLASSES.has(className)
    );
    if (names.length !== 1) return null;
    return {
      name: ` name="${names[0].slice("codicon-".length)}"`,
      className: makeClassNameAttribute(
        classes
          .filter(
            (className) => className !== "codicon" && className !== names[0]
          )
          .join(" ")
      ),
    };
  }

  const template = unwrapAttributeValue(expressionValue, "`");
  if (template === null) return null;
  const interpolationMatches = [...template.matchAll(/\$\{([^}]*)\}/g)];
  const literalTemplate = template.replace(/\$\{[^}]*\}/g, " ");
  const staticName = literalTemplate.match(
    /(?:^|\s)(codicon-(?!modifier-spin\b|sm\b|lg\b|xl\b)[a-z0-9]+(?:-[a-z0-9]+)*)/
  );
  if (staticName) {
    const className = template
      .replace(/^\s*codicon\s+/, "")
      .replace(staticName[1], "")
      .trim();
    return {
      name: ` name="${staticName[1].slice("codicon-".length)}"`,
      className: makeClassNameAttribute(className),
    };
  }

  if (interpolationMatches.length > 0) {
    const interpolation = interpolationMatches[0];
    const expression = interpolation[1];
    const before = template.slice(0, interpolation.index).trim();
    const after = template
      .slice(interpolation.index + interpolation[0].length)
      .trim();
    const beforeTokens = before.split(/\s+/).filter(Boolean);
    const afterTokens = after.split(/\s+/).filter(Boolean);
    const dynamicNameToken = beforeTokens.at(-1);

    if (dynamicNameToken?.startsWith("codicon-")) {
      const prefix = dynamicNameToken.slice("codicon-".length);
      const className = [...beforeTokens.slice(0, -1), ...afterTokens]
        .filter((className) => className !== "codicon")
        .join(" ");
      const name = prefix
        ? ` name={\`${prefix}\${${expression}}\`}`
        : ` name={${expression}}`;
      return { name, className: makeClassNameAttribute(className) };
    }

    if (interpolationMatches.length === 1 && beforeTokens[0] === "codicon") {
      const className = [...beforeTokens.slice(1), ...afterTokens].join(" ");
      return {
        name: ` name={${expression}}`,
        className: makeClassNameAttribute(className),
      };
    }
  }
  return null;
}

function transformTag(tagSource, tagName, sourceOffset, source) {
  const attributes = parseAttributes(tagSource, tagName);
  if (!attributes)
    return { replacement: null, reason: "could not parse attributes" };
  const classAttributes = attributes.filter(({ name }) => name === "className");
  if (classAttributes.length !== 1)
    return { replacement: null, reason: "className is missing or duplicated" };
  const iconClass = parseIconClass(classAttributes[0].value);
  if (!iconClass)
    return { replacement: null, reason: "codicon class shape is ambiguous" };

  const extraAttributes = attributes.filter(({ name }) => name !== "className");
  const forwarded = [];
  for (const attribute of extraAttributes) {
    if (attribute.name === "aria-hidden") {
      const hiddenValue =
        unwrapAttributeValue(attribute.value, '"') ??
        unwrapAttributeValue(attribute.value, "'");
      if (hiddenValue !== "true")
        return {
          replacement: null,
          reason: "aria-hidden is not statically true",
        };
      continue;
    }
    if (attribute.name === "style") {
      forwarded.push(` style=${attribute.value}`);
      continue;
    }
    return {
      replacement: null,
      reason: `unsupported attribute '${attribute.name}'`,
    };
  }

  const line = source.slice(0, sourceOffset).split("\n").length;
  return {
    replacement: `<Icon${iconClass.name}${iconClass.className}${forwarded.join("")} />`,
    line,
  };
}

function importPathFor(filePath) {
  let relative = path.relative(
    path.dirname(filePath),
    path.join(SHARED_COMPONENT_DIR, "Icon")
  );
  relative = relative.split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function addImport(source, filePath) {
  if (/import\s*\{[^}]*\bIcon\b[^}]*\}\s*from\s*["'][^"']+["']/.test(source)) {
    return source;
  }
  const importPattern = /^import\b[\s\S]*?;\r?\n?/gm;
  let lastImport = null;
  for (const match of source.matchAll(importPattern)) lastImport = match;
  const statement = `import { Icon } from "${importPathFor(filePath)}";\n`;
  if (!lastImport || lastImport.index === undefined) return statement + source;
  const insertionPoint = lastImport.index + lastImport[0].length;
  return (
    source.slice(0, insertionPoint) + statement + source.slice(insertionPoint)
  );
}

function transformFile(filePath) {
  if (path.resolve(filePath) === path.join(SHARED_COMPONENT_DIR, "Icon.tsx")) {
    return { changed: false, skips: [] };
  }
  const source = fs.readFileSync(filePath, "utf8");
  const replacements = [];
  const skips = [];
  const tagPattern = /<(i|span)\b(?:(?!<)[\s\S])*?\/>/g;
  for (const match of source.matchAll(tagPattern)) {
    const tagEnd = match.index + match[0].length;
    const tagSource = match[0];
    if (!/\bcodicon(?:-|\s|[`"'])/.test(tagSource)) continue;
    const result = transformTag(tagSource, match[1], match.index, source);
    if (result.replacement)
      replacements.push({
        start: match.index,
        end: tagEnd,
        replacement: result.replacement,
      });
    else {
      skips.push({
        filePath,
        line: source.slice(0, match.index).split("\n").length,
        reason: result.reason,
      });
    }
  }
  if (replacements.length === 0) return { changed: false, skips };
  let transformed = source;
  for (const replacement of replacements.reverse()) {
    transformed =
      transformed.slice(0, replacement.start) +
      replacement.replacement +
      transformed.slice(replacement.end);
  }
  transformed = addImport(transformed, filePath);
  fs.writeFileSync(filePath, transformed);
  return { changed: true, skips };
}

const argumentsToProcess = process.argv.slice(2);
if (argumentsToProcess.length === 0) usage();

const files = [...new Set(argumentsToProcess.flatMap(collectFiles))].sort();
let changedCount = 0;
let skipCount = 0;
for (const filePath of files) {
  const result = transformFile(filePath);
  if (result.changed) {
    changedCount += 1;
    console.log(`updated ${path.relative(REPO_ROOT, filePath)}`);
  }
  for (const skip of result.skips) {
    skipCount += 1;
    console.warn(
      `skip ${path.relative(REPO_ROOT, skip.filePath)}:${skip.line} — ${skip.reason}`
    );
  }
}
console.log(
  `codemod complete: ${changedCount} file(s) updated, ${skipCount} site(s) skipped`
);
