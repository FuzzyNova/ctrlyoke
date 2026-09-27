import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const BUNDLE_PATHS = [
  { name: "CLI", path: path.join(ROOT_DIR, "out", "cli.js") },
  { name: "MCP server", path: path.join(ROOT_DIR, "out", "mcp-server.js") },
  { name: "extension", path: path.join(ROOT_DIR, "out", "extension.js") },
];

test("main bundles load without throwing during module initialization", (t) => {
  for (const { name, path: bundlePath } of BUNDLE_PATHS) {
    if (!fs.existsSync(bundlePath)) {
      t.skip(`${path.relative(ROOT_DIR, bundlePath)} not built`);
      return;
    }

    const result =
      name === "CLI"
        ? spawnSync(process.execPath, [bundlePath, "--version"], {
            cwd: ROOT_DIR,
            encoding: "utf8",
            windowsHide: true,
          })
        : name === "MCP server"
          ? spawnSync(
              process.execPath,
              [
                bundlePath,
                "--tool",
                "list_harnesses",
                "--args",
                "{}",
                "--workspace",
                ".",
              ],
              { cwd: ROOT_DIR, encoding: "utf8", windowsHide: true }
            )
          : spawnSync(
              process.execPath,
              [
                "-e",
                `const Module = require("node:module");
const originalLoad = Module._load;
const vscode = new Proxy({
  EventEmitter: class {
    event = () => {};
    fire() {}
    dispose() {}
  },
}, {
  get: (target, key) => key in target ? target[key] : vscode,
  apply: () => vscode,
  construct: () => vscode,
});
Module._load = function (request, parent, isMain) {
  return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
};
require(process.argv[1]);`,
                bundlePath,
              ],
              { cwd: ROOT_DIR, encoding: "utf8", windowsHide: true }
            );

    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(
      output,
      /Cannot read properties of undefined \(reading 'CLAUDE_CLI'\)/
    );
    if (name === "CLI" || name === "extension") {
      assert.equal(result.status, 0, `${name} failed to load:\n${output}`);
    }
  }
});
