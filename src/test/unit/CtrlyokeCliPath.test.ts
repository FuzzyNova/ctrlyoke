import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CTRLYOKE_BIN_DIRNAME,
  findPathKey,
  getCtrlyokeBinDirectory,
  prependToPath,
  registerCtrlyokeBinDirectory,
  resetCtrlyokeBinDirectory,
  resolvePackageRootFromEntry,
  withCtrlyokeBinOnPath,
} from "../../utils/CtrlyokeCliPath";
import { CliProviderUtils } from "../../core/harness/shared/CliProviderUtils";

suite("CtrlyokeCliPath", () => {
  let tempRoot: string;

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctrlyoke-cli-path-"));
    resetCtrlyokeBinDirectory();
  });

  teardown(() => {
    resetCtrlyokeBinDirectory();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  suite("resolvePackageRootFromEntry", () => {
    test("climbs out of the bundle out/ directory", () => {
      const root = path.join(tempRoot, "pkg");
      assert.strictEqual(
        resolvePackageRootFromEntry(path.join(root, "out", "cli.js")),
        root
      );
    });

    test("returns the entry directory when it is not out/", () => {
      const dir = path.join(tempRoot, "src");
      assert.strictEqual(
        resolvePackageRootFromEntry(path.join(dir, "cli.ts")),
        dir
      );
    });
  });

  suite("prependToPath", () => {
    test("puts the directory first with the POSIX delimiter", () => {
      const env = prependToPath({ PATH: "/usr/bin:/bin" }, "/opt/x", "linux");
      assert.strictEqual(env.PATH, "/opt/x:/usr/bin:/bin");
    });

    test("reuses the existing Windows key spelling instead of adding PATH", () => {
      const env = prependToPath(
        { Path: "C:\\Windows;C:\\Tools" },
        "C:\\ext\\bin",
        "win32"
      );
      assert.strictEqual(env.Path, "C:\\ext\\bin;C:\\Windows;C:\\Tools");
      assert.strictEqual(env.PATH, undefined);
    });

    test("moves an existing entry to the front instead of duplicating it", () => {
      const env = prependToPath(
        { Path: "C:\\Windows;c:\\EXT\\bin;C:\\Tools" },
        "C:\\ext\\bin",
        "win32"
      );
      assert.strictEqual(env.Path, "C:\\ext\\bin;C:\\Windows;C:\\Tools");
    });

    test("creates PATH when the environment has none", () => {
      assert.strictEqual(prependToPath({}, "/opt/x", "linux").PATH, "/opt/x");
    });

    test("does not mutate the input environment", () => {
      const input = { PATH: "/usr/bin" };
      prependToPath(input, "/opt/x", "linux");
      assert.strictEqual(input.PATH, "/usr/bin");
    });
  });

  suite("registration", () => {
    test("ignores a package root without a bin/ directory", () => {
      registerCtrlyokeBinDirectory(tempRoot);
      assert.strictEqual(getCtrlyokeBinDirectory(), undefined);
      const env = { PATH: "/usr/bin" };
      assert.deepStrictEqual(withCtrlyokeBinOnPath(env), env);
    });

    test("prepends a registered bin/ directory to spawn environments", () => {
      const binDirectory = path.join(tempRoot, CTRLYOKE_BIN_DIRNAME);
      fs.mkdirSync(binDirectory);
      registerCtrlyokeBinDirectory(tempRoot);
      assert.strictEqual(getCtrlyokeBinDirectory(), binDirectory);

      const env = CliProviderUtils.buildProcessEnv();
      assert.strictEqual(
        env[findPathKey(env)]?.split(path.delimiter)[0],
        binDirectory,
        "harness spawn env should resolve ctrlyoke to this host's launcher"
      );
    });
  });
});
