import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findForbiddenOutEntries,
  findForbiddenPackageDependencies,
  findPackagingViolations,
} from "./assert-no-copilot-runtime.mjs";

test("detects Copilot runtime package dependencies", () => {
  assert.deepEqual(
    findForbiddenPackageDependencies({
      dependencies: { "@github/copilot-linux-x64": "1.0.0" },
      devDependencies: { "@github/copilot-sdk": "1.0.0" },
    }),
    ["dependencies:@github/copilot-linux-x64"]
  );
});

test("detects forbidden bundle references and native files", async () => {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ctrlyoke-packaging-guard-")
  );
  try {
    for (const bundleName of ["extension.js", "mcp-server.js", "cli.js"]) {
      await fs.writeFile(
        path.join(outDir, bundleName),
        "const copilot = 'copilot-cli';"
      );
    }
    await fs.writeFile(
      path.join(outDir, "mcp-server.js"),
      "require('@github/copilot-linux-x64');"
    );
    await fs.mkdir(path.join(outDir, "runtime"));
    await fs.writeFile(
      path.join(outDir, "runtime", "copilot-linux.node"),
      "native"
    );

    const violations = findForbiddenOutEntries(outDir, [
      path.join(outDir, "extension.js"),
      path.join(outDir, "mcp-server.js"),
      path.join(outDir, "cli.js"),
    ]);
    assert.equal(violations.length, 2);
    assert.ok(
      violations.some((violation) => violation.includes("@github/copilot"))
    );
    assert.ok(
      violations.some((violation) => violation.includes("copilot-linux.node"))
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("passes clean package and bundle inputs", async () => {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ctrlyoke-packaging-guard-")
  );
  try {
    for (const bundleName of ["extension.js", "mcp-server.js", "cli.js"]) {
      await fs.writeFile(
        path.join(outDir, bundleName),
        "const copilot = 'copilot-cli';"
      );
    }
    assert.deepEqual(
      findPackagingViolations({
        packageJson: { dependencies: {} },
        outDir,
        bundleFiles: [
          path.join(outDir, "extension.js"),
          path.join(outDir, "mcp-server.js"),
          path.join(outDir, "cli.js"),
        ],
      }),
      []
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
