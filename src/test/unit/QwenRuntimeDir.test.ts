import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { resolveQwenRuntimeDirs } from "../../core/harness/qwen/QwenRuntimeDir";
import { defaultQwenSystemDefaultsPath } from "../../core/harness/qwen/QwenSystemSettings";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("QwenRuntimeDir", () => {
  let root: string;
  let qwenHome: string;
  let workspace: string;
  let env: Record<string, string>;

  const write = (filePath: string, settings: unknown) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings));
  };
  const userSettings = () => path.join(qwenHome, "settings.json");
  const workspaceSettings = () =>
    path.join(workspace, ".qwen", "settings.json");
  const runtime = (dir: string) => ({ advanced: { runtimeOutputDir: dir } });

  setup(() => {
    root = makeTempDir("qwen-runtime-dir-");
    qwenHome = path.join(root, "home");
    workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    // Every layer points into the temp folder, so the machine's real system
    // settings never take part.
    env = {
      QWEN_HOME: qwenHome,
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, "system.json"),
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, "defaults.json"),
      RUNTIME_ROOT: path.join(root, "from-var"),
    };
  });

  teardown(() => removeTempDir(root));

  test("falls back to the Qwen home without a setting", () => {
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [qwenHome]);
  });

  test("QWEN_RUNTIME_DIR wins over every setting", () => {
    write(userSettings(), runtime(path.join(root, "user")));
    const override = path.join(root, "override");
    assert.deepStrictEqual(
      resolveQwenRuntimeDirs(workspace, { ...env, QWEN_RUNTIME_DIR: override }),
      [override]
    );
  });

  test("merges system defaults < user < workspace < system", () => {
    write(env.QWEN_CODE_SYSTEM_DEFAULTS_PATH, runtime(path.join(root, "d")));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(root, "d"),
    ]);
    write(userSettings(), runtime(path.join(root, "u")));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(root, "u"),
    ]);
    write(workspaceSettings(), runtime(path.join(root, "w")));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(root, "w"),
    ]);
    write(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, runtime(path.join(root, "s")));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(root, "s"),
    ]);
  });

  test("an empty value in a higher layer means unset", () => {
    write(userSettings(), runtime(path.join(root, "u")));
    write(workspaceSettings(), runtime(""));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [qwenHome]);
  });

  test("substitutes variables and resolves ~ and relative paths", () => {
    write(userSettings(), runtime("${RUNTIME_ROOT}/qwen"));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(root, "from-var", "qwen"),
    ]);
    write(userSettings(), runtime("$UNSET_VARIABLE/qwen"));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(workspace, "$UNSET_VARIABLE", "qwen"),
    ]);
    write(userSettings(), runtime("relative/out"));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(workspace, "relative", "out"),
    ]);
    write(userSettings(), runtime("~/qwen-out"));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(os.homedir(), "qwen-out"),
    ]);
  });

  test("reads settings files with comments", () => {
    fs.mkdirSync(qwenHome, { recursive: true });
    fs.writeFileSync(
      userSettings(),
      `{\n  // moved\n  "advanced": { "runtimeOutputDir": ${JSON.stringify(path.join(root, "u"))} }\n}`
    );
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(root, "u"),
    ]);
  });

  test("with folder trust on, also looks where an untrusted workspace would write", () => {
    write(userSettings(), {
      ...runtime(path.join(root, "u")),
      security: { folderTrust: { enabled: true } },
    });
    write(workspaceSettings(), runtime(path.join(root, "w")));
    assert.deepStrictEqual(resolveQwenRuntimeDirs(workspace, env), [
      path.join(root, "w"),
      path.join(root, "u"),
    ]);
    // A workspace cannot turn folder trust off for itself.
    write(workspaceSettings(), {
      ...runtime(path.join(root, "w")),
      security: { folderTrust: { enabled: false } },
    });
    assert.strictEqual(resolveQwenRuntimeDirs(workspace, env).length, 2);
  });

  test("system defaults live beside the system settings unless moved", () => {
    assert.strictEqual(
      defaultQwenSystemDefaultsPath(
        { QWEN_CODE_SYSTEM_SETTINGS_PATH: "/etc/custom/settings.json" },
        "linux"
      ),
      "/etc/custom/system-defaults.json"
    );
    assert.strictEqual(
      defaultQwenSystemDefaultsPath({}, "win32"),
      "C:\\ProgramData\\qwen-code\\system-defaults.json"
    );
    assert.strictEqual(
      defaultQwenSystemDefaultsPath(
        { QWEN_CODE_SYSTEM_DEFAULTS_PATH: "/x/defaults.json" },
        "linux"
      ),
      "/x/defaults.json"
    );
  });
});
