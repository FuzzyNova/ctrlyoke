/**
 * Copy the screenshots the docs reference from images/screenshots/ (the single
 * canonical copy) into docs/public/screenshots/, which is gitignored.
 *
 * VitePress leaves a markdown image path that points outside docs/ as a literal
 * URL instead of bundling it, so docs pages reference `/screenshots/<file>` and
 * this script materializes exactly those files before `docs:dev`/`docs:build`.
 * Only referenced files are copied, so large landing-only media never ships
 * with the docs site.
 *
 * README.md is scanned too. It is the Marketplace page, and every published
 * VSIX freezes it, so its images need stable absolute URLs; the docs site keeps
 * original file names, which makes `https://ctrlyoke.dev/docs/screenshots/<file>`
 * one. A README image therefore has to be materialized here even when no docs
 * page uses it.
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

/** Markdown outside docs/ whose images are served from the docs site. */
const EXTRA_SOURCES = ["README.md"];

/**
 * A root-relative `/screenshots/<file>` (docs pages) or the docs site's
 * absolute URL for the same file (README.md).
 */
const SCREENSHOT_REF =
  /(?:(?<=["'(])|https:\/\/ctrlyoke\.dev\/docs)\/screenshots\/([^"'()\s?#]+)/g;

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
  extraSources = EXTRA_SOURCES.map((file) => join(ROOT, file)),
} = {}) {
  const pagesByFile = new Map();
  const addReferences = (page, label) => {
    for (const file of findScreenshotReferences(readFileSync(page, "utf8"))) {
      const pages = pagesByFile.get(file) ?? new Set();
      pages.add(label);
      pagesByFile.set(file, pages);
    }
  };
  for (const page of collectMarkdown(docsDir)) {
    addReferences(page, relative(docsDir, page).replaceAll("\\", "/"));
  }
  for (const page of extraSources.filter((file) => existsSync(file))) {
    addReferences(page, relative(ROOT, page).replaceAll("\\", "/"));
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
