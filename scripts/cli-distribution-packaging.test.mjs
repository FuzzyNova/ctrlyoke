// Guards the bundled-CLI contract from dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.1:
// the VSIX ships out/cli.js plus bin/ launcher shims, and each shim runs its
// sibling bundle.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const BIN_DIR = path.join(ROOT_DIR, "bin");
const SHIMS = [
  { name: "ctrlyoke", bundle: "cli.js" },
  { name: "ctrlyoke-mcp", bundle: "mcp-server.js" },
];

function vscodeignoreNegations() {
  return new Set(
    fs
      .readFileSync(path.join(ROOT_DIR, ".vscodeignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1))
  );
}

test(".vscodeignore ships the CLI bundle and every launcher shim", () => {
  const included = vscodeignoreNegations();
  for (const required of [
    "out/cli.js",
    "out/mcp-server.js",
    ...SHIMS.flatMap(({ name }) => [`bin/${name}`, `bin/${name}.cmd`]),
  ]) {
    assert.ok(
      included.has(required),
      `.vscodeignore must include !${required}`
    );
  }
});

test("each shim launches its sibling bundle", () => {
  for (const { name, bundle } of SHIMS) {
    const posix = fs.readFileSync(path.join(BIN_DIR, name), "utf8");
    assert.match(posix, /^#!\/bin\/sh\n/, `${name} needs a sh shebang and LF`);
    assert.ok(posix.includes(`/../out/${bundle}"`), `${name} -> out/${bundle}`);

    const cmd = fs.readFileSync(path.join(BIN_DIR, `${name}.cmd`), "utf8");
    assert.ok(
      cmd.includes(`..\\out\\${bundle}"`),
      `${name}.cmd -> out\\${bundle}`
    );
  }
});

test("POSIX shims are committed executable", () => {
  const staged = execFileSync(
    "git",
    ["ls-files", "--stage", "--", ...SHIMS.map(({ name }) => `bin/${name}`)],
    { cwd: ROOT_DIR, encoding: "utf8" }
  );
  for (const { name } of SHIMS) {
    const line = staged
      .split("\n")
      .find((entry) => entry.endsWith(`bin/${name}`));
    assert.ok(line, `bin/${name} must be tracked`);
    assert.ok(line.startsWith("100755 "), `bin/${name} must be mode 100755`);
  }
});

test("the platform's ctrlyoke shim runs the compiled CLI", (t) => {
  if (!fs.existsSync(path.join(ROOT_DIR, "out", "cli.js"))) {
    t.skip("out/cli.js not built");
    return;
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")
  ).version;
  const result =
    process.platform === "win32"
      ? spawnSync(
          "cmd.exe",
          ["/d", "/c", path.join(BIN_DIR, "ctrlyoke.cmd"), "--version"],
          {
            encoding: "utf8",
            windowsHide: true,
          }
        )
      : spawnSync("sh", [path.join(BIN_DIR, "ctrlyoke"), "--version"], {
          encoding: "utf8",
        });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
});
