import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cleanStaleTestTempDirs,
  findStaleTempDirs,
  STALE_TEMP_MAX_AGE_MS,
} from "./clean-stale-test-temp.mjs";

function withFixtureRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), "ctrlyoke-stale-sweep-test-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Creates `name` under `root` and backdates its mtime by `ageMs`. */
function makeAgedDir(root, name, ageMs) {
  const dirPath = join(root, name);
  mkdirSync(dirPath);
  const agedTime = (Date.now() - ageMs) / 1000;
  utimesSync(dirPath, agedTime, agedTime);
  return dirPath;
}

test("finds a stale, prefixed directory but not a fresh one", () => {
  withFixtureRoot((root) => {
    const stale = makeAgedDir(
      root,
      "cy-ws-viewer-abc",
      STALE_TEMP_MAX_AGE_MS + 1000
    );
    const fresh = makeAgedDir(root, "cy-ws-viewer-def", 1000);

    const found = findStaleTempDirs({ root });

    assert.deepEqual(found, [stale]);
    assert.ok(!found.includes(fresh));
  });
});

test("ignores a directory that does not match a known prefix", () => {
  withFixtureRoot((root) => {
    makeAgedDir(root, "some-other-tool-cache", STALE_TEMP_MAX_AGE_MS + 1000);

    assert.deepEqual(findStaleTempDirs({ root }), []);
  });
});

test("matches every known prefix", () => {
  withFixtureRoot((root) => {
    const cy = makeAgedDir(root, "cy-attach-xyz", STALE_TEMP_MAX_AGE_MS + 1);
    const ctrlyoke = makeAgedDir(
      root,
      "ctrlyoke-external-root-xyz",
      STALE_TEMP_MAX_AGE_MS + 1
    );
    const stepPalette = makeAgedDir(
      root,
      "step-palette-xyz",
      STALE_TEMP_MAX_AGE_MS + 1
    );

    const found = findStaleTempDirs({ root });

    assert.deepEqual(new Set(found), new Set([cy, ctrlyoke, stepPalette]));
  });
});

test("removes every stale directory it finds and reports counts", () => {
  withFixtureRoot((root) => {
    makeAgedDir(root, "cy-ws-viewer-abc", STALE_TEMP_MAX_AGE_MS + 1000);
    makeAgedDir(root, "cy-ws-viewer-def", STALE_TEMP_MAX_AGE_MS + 1000);
    const fresh = makeAgedDir(root, "cy-ws-viewer-ghi", 1000);

    const { found, removed } = cleanStaleTestTempDirs({ root });

    assert.equal(found, 2);
    assert.equal(removed, 2);
    assert.deepEqual(findStaleTempDirs({ root, maxAgeMs: 0 }), [fresh]);
  });
});

test("removes a stale directory's junction without deleting through it", () => {
  const outside = mkdtempSync(join(tmpdir(), "ctrlyoke-stale-sweep-target-"));
  try {
    writeFileSync(join(outside, "keep.txt"), "keep");
    withFixtureRoot((root) => {
      const stale = join(root, "ctrlyoke-lsp-integration-abc");
      mkdirSync(join(stale, "node_modules"), { recursive: true });
      symlinkSync(
        outside,
        join(stale, "node_modules", "typescript"),
        process.platform === "win32" ? "junction" : "dir"
      );
      const agedTime = (Date.now() - STALE_TEMP_MAX_AGE_MS - 1000) / 1000;
      utimesSync(stale, agedTime, agedTime);

      assert.deepEqual(cleanStaleTestTempDirs({ root }), {
        found: 1,
        removed: 1,
      });
    });
    assert.deepEqual(readdirSync(outside), ["keep.txt"]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
