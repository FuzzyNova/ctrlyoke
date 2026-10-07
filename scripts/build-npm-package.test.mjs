// Guards the npm package from dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.2: the
// generated manifest, the packed file list, and an installed tarball that
// actually runs `ctrlyoke --version` and `ctrlyoke validate`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  NPM_PACKAGE_ENTRIES,
  NPM_PACKAGE_NAME,
  buildNpmPackage,
  buildNpmPackageJson,
} from "./build-npm-package.mjs";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const ROOT_PACKAGE = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8")
);
const IS_WINDOWS = process.platform === "win32";

/** Run npm through the same npm that launched the tests when there is one. */
function runNpm(args, options) {
  const npmCli = process.env.npm_execpath;
  const result =
    npmCli && npmCli.endsWith(".js")
      ? spawnSync(process.execPath, [npmCli, ...args], options)
      : spawnSync("npm", args, { ...options, shell: IS_WINDOWS });
  assert.equal(result.status, 0, `npm ${args.join(" ")}\n${result.stderr}`);
  return result.stdout;
}

/** Run a command npm linked into `<prefix>` for a global install. */
function runInstalled(prefix, command, args, options) {
  return IS_WINDOWS
    ? spawnSync(
        "cmd.exe",
        ["/d", "/c", path.join(prefix, `${command}.cmd`), ...args],
        { ...options, windowsHide: true }
      )
    : spawnSync(path.join(prefix, "bin", command), args, options);
}

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-npm-pkg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("generated package.json is standalone and mirrors the root version", () => {
  const manifest = buildNpmPackageJson(ROOT_PACKAGE);
  assert.equal(manifest.name, NPM_PACKAGE_NAME);
  assert.equal(manifest.version, ROOT_PACKAGE.version);
  assert.deepEqual(manifest.bin, {
    ctrlyoke: "out/cli.js",
    "ctrlyoke-mcp": "out/mcp-server.js",
  });
  assert.deepEqual(
    NPM_PACKAGE_ENTRIES.filter((entry) =>
      ["out/server/", "out/ui/webview-react/", "out/runtime-deps/"].includes(
        entry
      )
    ),
    ["out/server/", "out/ui/webview-react/", "out/runtime-deps/"]
  );
  assert.equal(manifest.engines.node, ROOT_PACKAGE.engines.node);
  assert.equal(manifest.license, ROOT_PACKAGE.license);
  assert.deepEqual(manifest.repository, ROOT_PACKAGE.repository);
  assert.equal(manifest.homepage, ROOT_PACKAGE.homepage);
  assert.deepEqual(manifest.bugs, ROOT_PACKAGE.bugs);
  for (const field of [
    "dependencies",
    "devDependencies",
    "contributes",
    "scripts",
  ]) {
    assert.equal(manifest[field], undefined, `${field} must not be published`);
  }
});

test("every packaged out/ entry also ships in the VSIX", () => {
  const vscodeignore = fs.readFileSync(
    path.join(ROOT_DIR, ".vscodeignore"),
    "utf8"
  );
  const allowlist = vscodeignore.replace(/\r\n/g, "\n").split("\n");
  for (const entry of NPM_PACKAGE_ENTRIES.filter((e) => e.startsWith("out/"))) {
    const allowed = entry.endsWith("/")
      ? allowlist.some((line) => line.startsWith(`!${entry}`))
      : allowlist.includes(`!${entry}`);
    assert.ok(
      allowed,
      `.vscodeignore must allowlist ${entry}`
    );
  }
});

test("the packed tarball installs and runs", async (t) => {
  if (!fs.existsSync(path.join(ROOT_DIR, "out", "cli.js"))) {
    t.skip("out/cli.js not built");
    return;
  }
  const tempDir = makeTempDir(t);
  const packageDir = path.join(tempDir, "package");
  buildNpmPackage({ outDir: packageDir });

  await t.test(
    "the file list holds the runtime assets and nothing else",
    () => {
      const [packed] = JSON.parse(
        runNpm(["pack", "--dry-run", "--json"], {
          cwd: packageDir,
          encoding: "utf8",
        })
      );
      const files = packed.files.map((file) => file.path);
      for (const entry of NPM_PACKAGE_ENTRIES) {
        assert.ok(
          entry.endsWith("/")
            ? files.some((file) => file.startsWith(entry))
            : files.includes(entry),
          `package must contain ${entry}`
        );
      }
      for (const runtimeAsset of [
        "out/server/standalone-shim.js",
        "out/server/themes/vscode-default-dark.css",
        "out/server/themes/vscode-default-light.css",
        "out/ui/webview-react/index.html",
      ]) {
        assert.ok(
          files.includes(runtimeAsset),
          `package must contain ${runtimeAsset}`
        );
      }
      assert.ok(
        files.some((file) => file.startsWith("out/runtime-deps/node_modules/")),
        "package must contain isolated runtime dependencies"
      );
      assert.ok(files.includes("README.md") && files.includes("package.json"));
      for (const file of files) {
        assert.ok(!file.endsWith(".map"), `${file}: no source maps`);
      }
      for (const extensionOnly of [
        "out/extension.js",
        "out/ui/webview-scripts/",
        "node_modules/",
      ]) {
        assert.ok(
          !files.some((file) => file.startsWith(extensionOnly)),
          `${extensionOnly} is extension-only`
        );
      }
    }
  );

  await t.test(
    "`ctrlyoke --version` and `validate` work from a global install",
    () => {
      runNpm(["pack", "--pack-destination", tempDir, "--silent"], {
        cwd: packageDir,
        encoding: "utf8",
      });
      const tarball = path.join(
        tempDir,
        `${NPM_PACKAGE_NAME}-${ROOT_PACKAGE.version}.tgz`
      );
      const prefix = path.join(tempDir, "prefix");
      runNpm(
        [
          "install",
          "-g",
          "--prefix",
          prefix,
          tarball,
          "--no-audit",
          "--no-fund",
        ],
        { encoding: "utf8" }
      );

      const workspace = path.join(tempDir, "workspace");
      fs.mkdirSync(workspace);
      fs.writeFileSync(
        path.join(workspace, "hello.ctrlyoke.yaml"),
        "prompt: Say hello\n"
      );
      // Keep the install registry out of the developer's real ~/.ctrlyoke.
      const options = {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, CTRLYOKE_HOME: path.join(tempDir, "home") },
      };

      const version = runInstalled(prefix, "ctrlyoke", ["--version"], options);
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout.trim(), ROOT_PACKAGE.version);

      const validate = runInstalled(
        prefix,
        "ctrlyoke",
        ["validate", "hello.ctrlyoke.yaml", "--json"],
        options
      );
      assert.equal(validate.status, 0, validate.stderr);
      const result = JSON.parse(validate.stdout.trim().split("\n").pop());
      assert.equal(result.success, true);
    }
  );
});
