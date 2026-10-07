import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { findNodeBundleVscodeViolations } = require(
  "./node-bundle-vscode-guard.cjs"
);

test("detects VS Code packages and platform files in Node bundle metafiles", () => {
  const violations = findNodeBundleVscodeViolations({
    inputs: {
      "node_modules/vscode/index.js": {},
      "node_modules/@vscode/extension-telemetry/dist/index.js": {},
      "src/platform/VsCodeAdapter.ts": {},
      "src/cli.ts": {},
    },
    outputs: {
      "out/cli.js": {
        imports: [
          { path: "vscode", external: true },
          { path: "@vscode/extension-telemetry", external: true },
        ],
      },
    },
  });
  assert.deepEqual(violations, [
    "@vscode/extension-telemetry",
    "node_modules/@vscode/extension-telemetry/dist/index.js",
    "node_modules/vscode/index.js",
    "src/platform/VsCodeAdapter.ts",
    "vscode",
  ]);
});

test("accepts a Node bundle metafile with no VS Code runtime dependencies", () => {
  assert.deepEqual(
    findNodeBundleVscodeViolations({
      inputs: { "src/cli.ts": {} },
      outputs: { "out/cli.js": { imports: [{ path: "node:fs" }] } },
    }),
    []
  );
});
