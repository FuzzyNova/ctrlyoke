#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

export const PRODUCTION_BUNDLE_FILES = [
  "out/extension.js",
  "out/mcp-server.js",
  "out/cli.js",
];

const COPILOT_PACKAGE_PATTERN = /^@github\/copilot(?:-|$)/iu;
const COPILOT_BUNDLE_PATTERN = /@github\/copilot(?:-|\/)/iu;
const NATIVE_FILE_PATTERN = /\.(?:dll|dylib|exe|node|so)$/iu;
const COPILOT_NATIVE_REFERENCE_PATTERN =
  /\bcopilot[^\s"'\\]{0,80}\.(?:dll|dylib|exe|node|so)\b/iu;

function dependencyNames(packageJson, fieldName) {
  const value = packageJson?.[fieldName];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.keys(value);
  return [];
}

/**
 * Return runtime/package entries that would pull a GitHub Copilot runtime into
 * the extension package. This intentionally checks package.json only; the
 * lockfile is not itself shipped by the production build.
 */
export function findForbiddenPackageDependencies(packageJson) {
  const fields = [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ];
  const matches = [];

  for (const fieldName of fields) {
    for (const dependencyName of dependencyNames(packageJson, fieldName)) {
      if (
        typeof dependencyName === "string" &&
        COPILOT_PACKAGE_PATTERN.test(dependencyName)
      ) {
        matches.push(`${fieldName}:${dependencyName}`);
      }
    }
  }

  return matches;
}

function findNativeCopilotFiles(outDir) {
  if (!fs.existsSync(outDir)) return [];

  const matches = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path
        .relative(outDir, absolutePath)
        .split(path.sep)
        .join("/");

      if (relativePath.match(/(?:^|\/)@github\/copilot(?:-|\/|$)/iu)) {
        matches.push(relativePath);
      } else if (
        entry.isFile() &&
        NATIVE_FILE_PATTERN.test(entry.name) &&
        /copilot/iu.test(entry.name)
      ) {
        matches.push(relativePath);
      }

      if (entry.isDirectory()) visit(absolutePath);
    }
  }

  visit(outDir);
  return matches;
}

/**
 * Inspect the production JavaScript bundles and copied output for forbidden
 * Copilot package references or native Copilot artifacts.
 */
export function findForbiddenOutEntries(
  outDir,
  bundleFiles = PRODUCTION_BUNDLE_FILES
) {
  const matches = [];

  for (const relativeBundlePath of bundleFiles) {
    const bundlePath = path.isAbsolute(relativeBundlePath)
      ? relativeBundlePath
      : path.resolve(PROJECT_ROOT, relativeBundlePath);
    if (!fs.existsSync(bundlePath)) {
      matches.push(`missing bundle:${relativeBundlePath}`);
      continue;
    }

    const bundleText = fs.readFileSync(bundlePath, "utf8");
    if (COPILOT_BUNDLE_PATTERN.test(bundleText)) {
      matches.push(
        `bundle:${relativeBundlePath}:@github/copilot runtime reference`
      );
    }
    if (COPILOT_NATIVE_REFERENCE_PATTERN.test(bundleText)) {
      matches.push(`bundle:${relativeBundlePath}:native Copilot reference`);
    }
  }

  for (const relativePath of findNativeCopilotFiles(outDir)) {
    matches.push(`out:${relativePath}`);
  }

  return matches;
}

export function findPackagingViolations({
  packageJson,
  outDir,
  bundleFiles = PRODUCTION_BUNDLE_FILES,
}) {
  return [
    ...findForbiddenPackageDependencies(packageJson).map(
      (match) => `package.json:${match}`
    ),
    ...findForbiddenOutEntries(outDir, bundleFiles),
  ];
}

function run() {
  const packageJsonPath = path.join(PROJECT_ROOT, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const violations = findPackagingViolations({
    packageJson,
    outDir: path.join(PROJECT_ROOT, "out"),
  });

  if (violations.length > 0) {
    console.error(
      "[packaging-guard] forbidden @github/copilot runtime or native Copilot artifact detected:"
    );
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    "[packaging-guard] no @github/copilot runtime or native Copilot binaries found"
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run();
}
