import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  compareVersions,
  findOlderCli,
  INSTALLATION_KINDS,
  installationsFilePath,
  recordInstallation,
} from "../../utils/CtrlyokeInstallations";
import {
  formatNewerExtensionNotice,
  isBundledInExtension,
  noteCliInstallation,
} from "../../cli/CliInstallationNotice";

suite("CtrlyokeInstallations", () => {
  let tempRoot: string;
  let previousHome: string | undefined;

  async function packageRoot(
    name: string,
    manifest: Record<string, unknown> = {}
  ): Promise<string> {
    const root = path.join(tempRoot, name);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify(manifest),
      "utf8"
    );
    return root;
  }

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-installs-"));
    previousHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = path.join(tempRoot, "home");
  });

  teardown(async () => {
    if (previousHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = previousHome;
    }
    await fs.rm(tempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  test("compareVersions orders numerically and ignores pre-release tags", () => {
    assert.ok(compareVersions("0.10.0", "0.9.3") > 0);
    assert.strictEqual(compareVersions("1.2.0", "1.2"), 0);
    assert.strictEqual(compareVersions("0.3.0-beta.1", "0.3.0"), 0);
    assert.ok(compareVersions("0.2.1", "0.3.0") < 0);
  });

  test("records hosts and prunes installations whose folder is gone", async () => {
    const extension = await packageRoot("ext");
    const gone = path.join(tempRoot, "uninstalled");

    await recordInstallation({
      kind: INSTALLATION_KINDS.CLI,
      version: "0.1.0",
      packageRoot: gone,
    });
    const { others } = await recordInstallation({
      kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
      version: "0.2.0",
      packageRoot: extension,
    });

    assert.deepStrictEqual(others, []);
    const file = JSON.parse(await fs.readFile(installationsFilePath(), "utf8"));
    assert.strictEqual(Object.keys(file.installations).length, 1);
  });

  test("the bundled CLI and its extension keep separate records", async () => {
    const extension = await packageRoot("ext", { engines: { vscode: "^1" } });
    await recordInstallation({
      kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
      version: "0.2.0",
      packageRoot: extension,
    });
    const { others } = await recordInstallation({
      kind: INSTALLATION_KINDS.CLI,
      version: "0.2.0",
      packageRoot: extension,
    });
    assert.deepStrictEqual(
      others.map((record) => record.kind),
      [INSTALLATION_KINDS.VSCODE_EXTENSION]
    );
  });

  test("the extension finds an older npm CLI but not its own bundled copy", async () => {
    const extension = await packageRoot("ext", { engines: { vscode: "^1" } });
    const npmCli = await packageRoot("npm-cli");
    const self = {
      kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
      version: "0.3.0",
      packageRoot: extension,
      lastSeen: Date.now(),
    };
    const bundled = { ...self, kind: INSTALLATION_KINDS.CLI };
    const older = {
      kind: INSTALLATION_KINDS.CLI,
      version: "0.2.1",
      packageRoot: npmCli,
      lastSeen: Date.now(),
    };
    assert.strictEqual(findOlderCli(self, [bundled]), undefined);
    assert.strictEqual(findOlderCli(self, [bundled, older]), older);
  });

  suite("CLI notice", () => {
    test("warns once per version pair when a newer extension is recorded", async () => {
      const extension = await packageRoot("ext", { engines: { vscode: "^1" } });
      const npmCli = await packageRoot("npm-cli", { name: "ctrlyoke" });
      await recordInstallation({
        kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
        version: "0.3.0",
        packageRoot: extension,
      });

      const warnings: string[] = [];
      await noteCliInstallation("0.2.1", npmCli, (m) => warnings.push(m));
      await noteCliInstallation("0.2.1", npmCli, (m) => warnings.push(m));

      assert.deepStrictEqual(warnings, [
        formatNewerExtensionNotice("0.2.1", "0.3.0"),
      ]);
      assert.match(warnings[0], /npm install -g ctrlyoke@0\.3\.0/);
    });

    test("stays quiet for the copy bundled in an extension", async () => {
      const extension = await packageRoot("ext", { engines: { vscode: "^1" } });
      const newer = await packageRoot("ext-insiders", {
        engines: { vscode: "^1" },
      });
      await recordInstallation({
        kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
        version: "0.3.0",
        packageRoot: newer,
      });
      assert.ok(isBundledInExtension(extension));

      const warnings: string[] = [];
      await noteCliInstallation("0.2.1", extension, (m) => warnings.push(m));
      assert.deepStrictEqual(warnings, []);
    });

    test("stays quiet when the CLI is not older", async () => {
      const extension = await packageRoot("ext", { engines: { vscode: "^1" } });
      const npmCli = await packageRoot("npm-cli");
      await recordInstallation({
        kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
        version: "0.3.0",
        packageRoot: extension,
      });
      const warnings: string[] = [];
      await noteCliInstallation("0.3.0", npmCli, (m) => warnings.push(m));
      assert.deepStrictEqual(warnings, []);
    });
  });
});
