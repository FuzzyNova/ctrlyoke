/**
 * Copy the screenshots the docs reference from images/screenshots/ (the single
 * canonical copy) into docs/public/screenshots/, which is gitignored.
 *
 * VitePress leaves a markdown image path that points outside docs/ as a literal
 * URL instead of bundling it, so docs pages reference `/screenshots/<file>` and
 * this script materializes exactly those files before `docs:dev`/`docs:build`.
 * Only referenced files are copied, so large landing-only media never ships
 * with the docs site.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directories under docs/ that never hold authored pages. */
const SKIPPED_DIRS = new Set([".vitepress", "public", "node_modules"]);

const SCREENSHOT_REF = /(?<=["'(])\/screenshots\/([^"'()\s?#]+)/g;

/** File names referenced as `/screenshots/<file>` in one markdown source. */
export function findScreenshotReferences(markdown) {
  return [...markdown.matchAll(SCREENSHOT_REF)].map((match) => match[1]);
}

function collectMarkdown(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : collectMarkdown(entryPath);
    }
    return entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

/**
 * Replace targetDir with copies of every screenshot the docs reference.
 * Throws, naming each referencing page, when a referenced file is missing.
 */
export function syncDocsScreenshots({
  docsDir = join(ROOT, "docs"),
  sourceDir = join(ROOT, "images", "screenshots"),
  targetDir = join(ROOT, "docs", "public", "screenshots"),
} = {}) {
  const pagesByFile = new Map();
  for (const page of collectMarkdown(docsDir)) {
    for (const file of findScreenshotReferences(readFileSync(page, "utf8"))) {
      const pages = pagesByFile.get(file) ?? new Set();
      pages.add(relative(docsDir, page).replaceAll("\\", "/"));
      pagesByFile.set(file, pages);
    }
  }

  const missing = [...pagesByFile]
    .filter(([file]) => !existsSync(join(sourceDir, file)))
    .map(
      ([file, pages]) => `  ${file} (referenced by ${[...pages].join(", ")})`
    );
  if (missing.length > 0) {
    throw new Error(
      `Docs reference screenshots that are not in ${relative(ROOT, sourceDir)}:\n${missing.join("\n")}`
    );
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  const files = [...pagesByFile.keys()].sort();
  for (const file of files) {
    copyFileSync(join(sourceDir, file), join(targetDir, file));
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const files = syncDocsScreenshots();
    console.log(
      `Copied ${files.length} screenshot(s) into docs/public/screenshots/`
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
