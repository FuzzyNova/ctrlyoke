import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findScreenshotReferences,
  syncDocsScreenshots,
} from "./sync-docs-screenshots.mjs";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-docs-screenshots-"));
  const docsDir = join(root, "docs");
  const sourceDir = join(root, "screenshots");
  const targetDir = join(docsDir, "public", "screenshots");
  mkdirSync(join(docsDir, "guide"), { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  return { root, docsDir, sourceDir, targetDir };
}

test("finds markdown and HTML screenshot references, ignoring other paths", () => {
  const markdown = [
    "![Harness tab](/screenshots/harness-400x800.png)",
    '<img src="/screenshots/hooks-400x800.png" alt="Hooks">',
    "![Logo](/ctrlyoke-icon.svg)",
    "Screenshots live in /screenshots/ at build time.",
  ].join("\n");

  assert.deepEqual(findScreenshotReferences(markdown), [
    "harness-400x800.png",
    "hooks-400x800.png",
  ]);
});

test("copies only referenced screenshots and drops stale copies", () => {
  const { root, docsDir, sourceDir, targetDir } = makeFixture();
  try {
    writeFileSync(join(sourceDir, "used.png"), "used");
    writeFileSync(join(sourceDir, "unused.gif"), "unused");
    writeFileSync(
      join(docsDir, "guide", "page.md"),
      "![Used](/screenshots/used.png)"
    );
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "stale.png"), "stale");

    assert.deepEqual(syncDocsScreenshots({ docsDir, sourceDir, targetDir }), [
      "used.png",
    ]);
    assert.deepEqual(readdirSync(targetDir), ["used.png"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails with the referencing page when a screenshot is missing", () => {
  const { root, docsDir, sourceDir, targetDir } = makeFixture();
  try {
    writeFileSync(
      join(docsDir, "guide", "page.md"),
      "![Gone](/screenshots/gone.png)"
    );

    assert.throws(
      () => syncDocsScreenshots({ docsDir, sourceDir, targetDir }),
      /gone\.png \(referenced by guide\/page\.md\)/
    );
    assert.equal(existsSync(targetDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
