#!/usr/bin/env node
/**
 * Guards a release tag against package.json#version and extracts the
 * matching CHANGELOG.md section for use as the GitHub Release body.
 *
 * Usage:
 *   node scripts/verify-release-tag.mjs [tag] [changelogPath] [outPath]
 *
 * `tag` defaults to $GITHUB_REF_NAME (set by release.yml on a `vX.Y.Z` tag
 * push). Fails if the tag (minus its leading "v") doesn't match
 * package.json#version -- the "VSIX version matches package.json" guard.
 * Writes the matching "## [X.Y.Z] - <date>" CHANGELOG.md section to
 * release-notes.md (or outPath).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export function versionFromTag(tag) {
  return tag.replace(/^v/, "");
}

export function extractChangelogSection(changelog, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[${escapedVersion}\\].*$`, "m");
  const match = heading.exec(changelog);
  if (!match) {
    return null;
  }

  const rest = changelog.slice(match.index + match[0].length);
  const nextHeading = /^## \[/m.exec(rest);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return body.trim() + "\n";
}

function main() {
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
  if (!tag) {
    console.error(
      "verify-release-tag: no tag provided (pass as an argument or set GITHUB_REF_NAME)."
    );
    process.exit(1);
  }

  const changelogPath = process.argv[3] || join(rootDir, "CHANGELOG.md");
  const outPath = process.argv[4] || join(rootDir, "release-notes.md");
  const packageJsonPath = join(rootDir, "package.json");

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const tagVersion = versionFromTag(tag);

  if (tagVersion !== pkg.version) {
    console.error(
      `verify-release-tag: tag "${tag}" (version "${tagVersion}") does not match package.json#version "${pkg.version}".`
    );
    process.exit(1);
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const section = extractChangelogSection(changelog, pkg.version);
  if (!section) {
    console.error(
      `verify-release-tag: no "## [${pkg.version}]" heading found in ${changelogPath}.`
    );
    process.exit(1);
  }

  writeFileSync(outPath, section);
  console.log(
    `verify-release-tag: tag "${tag}" matches package.json#version "${pkg.version}". Wrote ${outPath}.`
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
