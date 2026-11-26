import { suite, test } from "mocha";
import * as assert from "assert";
import {
  DEV_HIDDEN_PATH_ENTRIES_ENV,
  findNewSearchPathEntries,
  parseMarkedEnvPath,
  readFreshSearchPath,
  refreshProcessSearchPath,
} from "../../utils/SearchPathRefresh";

suite("SearchPathRefresh", () => {
  test("parses PATH from the marked env block, ignoring profile noise", () => {
    const output = [
      "Welcome back! PATH=/not/this",
      "__CTRLYOKE_ENV_START__",
      "HOME=/Users/me",
      "PATH=/Users/me/.local/bin:/usr/bin",
      "SHELL=/bin/zsh",
      "__CTRLYOKE_ENV_END__",
      "",
    ].join("\n");

    assert.strictEqual(
      parseMarkedEnvPath(output),
      "/Users/me/.local/bin:/usr/bin"
    );
    assert.strictEqual(parseMarkedEnvPath("no markers"), undefined);
  });

  test("finds only entries the current PATH lacks, in fresh order, minus hidden ones", () => {
    assert.deepStrictEqual(
      findNewSearchPathEntries(
        "/usr/bin:/bin",
        "/home/me/.local/bin:/usr/bin:/opt/hidden:/opt/new:/bin:/opt/new",
        "/opt/hidden",
        "linux"
      ),
      ["/home/me/.local/bin", "/opt/new"]
    );
  });

  test("compares Windows entries case-insensitively", () => {
    assert.deepStrictEqual(
      findNewSearchPathEntries(
        "C:\\Windows\\System32",
        "c:\\windows\\system32;C:\\Users\\me\\.local\\bin",
        "",
        "win32"
      ),
      ["C:\\Users\\me\\.local\\bin"]
    );
  });

  test("appends a directory created after launch so a newly installed CLI resolves", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    const added = await refreshProcessSearchPath(
      async () => "/home/me/.local/bin:/usr/bin:/bin",
      env,
      "linux"
    );

    assert.deepStrictEqual(added, ["/home/me/.local/bin"]);
    assert.strictEqual(env.PATH, "/usr/bin:/bin:/home/me/.local/bin");
  });

  test("keeps existing PATH entries ahead of new entries", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

    await refreshProcessSearchPath(
      async () => "/home/me/.local/bin:/usr/bin:/bin",
      env,
      "linux"
    );

    assert.strictEqual(env.PATH, "/usr/bin:/bin:/home/me/.local/bin");
  });

  test("keeps the existing PATH spelling and order on Windows", async () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\b;C:\\a" };

    await refreshProcessSearchPath(
      async () => "C:\\a;C:\\new;C:\\b",
      env,
      "win32"
    );

    assert.deepStrictEqual(env, { Path: "C:\\b;C:\\a;C:\\new" });
  });

  test("never re-adds directories the dev host hid with --no-harnesses", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      [DEV_HIDDEN_PATH_ENTRIES_ENV]: "/home/me/.local/bin",
    };

    const added = await refreshProcessSearchPath(
      async () => "/home/me/.local/bin:/usr/bin",
      env,
      "linux"
    );

    assert.deepStrictEqual(added, []);
    assert.strictEqual(env.PATH, "/usr/bin");
  });

  test("leaves PATH unchanged when the shell cannot be read", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    assert.deepStrictEqual(
      await refreshProcessSearchPath(async () => undefined, env, "linux"),
      []
    );
    assert.deepStrictEqual(
      await refreshProcessSearchPath(
        async () => {
          throw new Error("boom");
        },
        env,
        "linux"
      ),
      []
    );
    assert.strictEqual(env.PATH, "/usr/bin");
  });

  test("reads a non-empty PATH from this machine's real shell", async function () {
    this.timeout(15_000);
    const freshPath = await readFreshSearchPath();
    assert.ok(freshPath && freshPath.length > 0, "expected a PATH value");
  });
});
