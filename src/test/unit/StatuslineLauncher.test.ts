import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import {
  deployStatuslineLauncher,
  packageStatuslineDirectory,
  removeStatuslineLauncher,
  resetStatuslineLauncherCache,
  resolveStatuslineScriptPath,
  STATUSLINE_LAUNCHER_FILES,
  statuslineLauncherDirectory,
  statuslineScriptFileName,
} from "../../core/harness/shared/StatuslineLauncher";
import { STATUS_LINE_TRACKING_PROVIDERS } from "../../types/DashboardConstants";
import { writeStatuslinePackage } from "../helpers/statuslinePackage";

suite("StatuslineLauncher", () => {
  let tempRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "statusline-launcher-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = path.join(tempRoot, "home");
    process.env.USERPROFILE = path.join(tempRoot, "home");
    resetStatuslineLauncherCache();
  });

  teardown(async () => {
    resetStatuslineLauncherCache();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  /** A package root whose statusline scripts all contain `marker`. */
  function packageRoot(
    name: string,
    version: string,
    marker: string
  ): Promise<string> {
    return writeStatuslinePackage(path.join(tempRoot, name), {
      version,
      contents: `// ${marker}`,
    });
  }

  async function deployedMarkers(): Promise<string[]> {
    const directory = statuslineLauncherDirectory();
    return Promise.all(
      STATUSLINE_LAUNCHER_FILES.map((file) =>
        fs.readFile(path.join(directory, file), "utf8")
      )
    );
  }

  async function deployFresh(root: string): Promise<string | undefined> {
    resetStatuslineLauncherCache();
    return deployStatuslineLauncher(root);
  }

  test("copies every script into ~/.ctrlyoke/bin and points harness config there", async () => {
    const root = await packageRoot("pkg", "0.2.0", "v0.2.0");

    const scriptPath = await resolveStatuslineScriptPath(
      root,
      STATUS_LINE_TRACKING_PROVIDERS.CLAUDE
    );

    const launcher = statuslineLauncherDirectory();
    assert.strictEqual(
      launcher,
      path.join(tempRoot, "home", ".ctrlyoke", "bin")
    );
    assert.strictEqual(
      scriptPath,
      path.join(
        launcher,
        statuslineScriptFileName(STATUS_LINE_TRACKING_PROVIDERS.CLAUDE)
      )
    );
    assert.ok((await deployedMarkers()).every((text) => text === "// v0.2.0"));
  });

  test("the newest version wins and an older host never downgrades it", async () => {
    const newer = await packageRoot("newer", "0.3.0", "v0.3.0");
    const older = await packageRoot("older", "0.2.0", "v0.2.0");

    await deployFresh(newer);
    assert.strictEqual(
      await deployFresh(older),
      statuslineLauncherDirectory(),
      "the older host still uses the shared launcher"
    );
    assert.ok((await deployedMarkers()).every((text) => text === "// v0.3.0"));

    const newest = await packageRoot("newest", "0.4.0", "v0.4.0");
    await deployFresh(newest);
    assert.ok((await deployedMarkers()).every((text) => text === "// v0.4.0"));
  });

  test("the same version refreshes changed scripts", async () => {
    await deployFresh(await packageRoot("a", "0.2.0", "first build"));
    await deployFresh(await packageRoot("b", "0.2.0", "second build"));
    assert.ok(
      (await deployedMarkers()).every((text) => text === "// second build")
    );
  });

  test("an older host repairs an incomplete launcher", async () => {
    await deployFresh(await packageRoot("newer", "0.3.0", "v0.3.0"));
    const missing = path.join(
      statuslineLauncherDirectory(),
      STATUSLINE_LAUNCHER_FILES[0]
    );
    await fs.rm(missing);

    await deployFresh(await packageRoot("older", "0.2.0", "v0.2.0"));
    assert.strictEqual(await fs.readFile(missing, "utf8"), "// v0.2.0");
  });

  test("redeploys when the launcher disappears mid-process", async () => {
    const root = await packageRoot("pkg", "0.2.0", "v0.2.0");
    await deployStatuslineLauncher(root);
    await removeStatuslineLauncher();

    await deployStatuslineLauncher(root);
    assert.ok((await deployedMarkers()).every((text) => text === "// v0.2.0"));
  });

  test("falls back to the package's own scripts when the launcher cannot deploy", async () => {
    const root = await writeStatuslinePackage(
      path.join(tempRoot, "unversioned")
    );

    assert.strictEqual(
      await resolveStatuslineScriptPath(
        root,
        STATUS_LINE_TRACKING_PROVIDERS.QWEN
      ),
      path.join(
        packageStatuslineDirectory(root),
        statuslineScriptFileName(STATUS_LINE_TRACKING_PROVIDERS.QWEN)
      )
    );
  });

  test("resolves nothing when neither the launcher nor the package has the script", async () => {
    const root = path.join(tempRoot, "no-scripts");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ version: "0.2.0" }),
      "utf8"
    );

    for (const packageRootPath of [root, "extension"]) {
      assert.strictEqual(
        await resolveStatuslineScriptPath(
          packageRootPath,
          STATUS_LINE_TRACKING_PROVIDERS.ANTIGRAVITY
        ),
        undefined,
        packageRootPath
      );
    }
  });

  test("removeStatuslineLauncher leaves unrelated files in the directory", async () => {
    await deployFresh(await packageRoot("pkg", "0.2.0", "v0.2.0"));
    const unrelated = path.join(statuslineLauncherDirectory(), "keep-me.txt");
    await fs.writeFile(unrelated, "user file", "utf8");

    await removeStatuslineLauncher();

    assert.deepStrictEqual(await fs.readdir(statuslineLauncherDirectory()), [
      "keep-me.txt",
    ]);
  });
});
