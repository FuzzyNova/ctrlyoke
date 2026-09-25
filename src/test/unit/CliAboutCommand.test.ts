import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  buildCliAboutInfo,
  CLI_ABOUT_JSON_SCHEMA_VERSION,
  CLI_DISTRIBUTIONS,
  formatCliAboutInfo,
} from "../../cli/CliAboutCommand";
import {
  INSTALLATION_KINDS,
  type InstallationRecord,
} from "../../utils/CtrlyokeInstallations";

suite("CliAboutCommand", () => {
  let tempRoot: string;

  setup(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-about-"));
  });

  teardown(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function packageRoot(
    name: string,
    manifest: Record<string, unknown>
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

  test("reports the npm copy and lists other installations but not itself", async () => {
    const npmCli = await packageRoot("npm-cli", { name: "ctrlyoke" });
    const extension = await packageRoot("ext", { engines: { vscode: "^1" } });
    const records: InstallationRecord[] = [
      {
        kind: INSTALLATION_KINDS.CLI,
        version: "0.2.0",
        packageRoot: npmCli,
        lastSeen: 2_000,
      },
      {
        kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
        version: "0.3.0",
        packageRoot: extension,
        lastSeen: 1_000,
      },
    ];

    const info = buildCliAboutInfo("0.2.0", npmCli, records);

    assert.strictEqual(info.schemaVersion, CLI_ABOUT_JSON_SCHEMA_VERSION);
    assert.strictEqual(info.distribution, CLI_DISTRIBUTIONS.NPM);
    assert.strictEqual(info.packageRoot, npmCli);
    assert.deepStrictEqual(
      info.otherInstallations.map((other) => other.packageRoot),
      [extension]
    );
    const text = formatCliAboutInfo(info);
    assert.match(text, /^ctrlyoke 0\.2\.0$/m);
    assert.match(text, /Installed as:\s+npm package/);
    assert.ok(text.includes(npmCli));
    assert.match(text, /VS Code extension 0\.3\.0/);
  });

  test("recognizes the copy bundled in the VS Code extension", async () => {
    const extension = await packageRoot("ext", { engines: { vscode: "^1" } });
    const info = buildCliAboutInfo("0.3.0", extension, [
      {
        kind: INSTALLATION_KINDS.VSCODE_EXTENSION,
        version: "0.3.0",
        packageRoot: extension,
        lastSeen: 1_000,
      },
    ]);

    assert.strictEqual(info.distribution, CLI_DISTRIBUTIONS.VSCODE_EXTENSION);
    // The extension shares the bundled CLI's folder but is still listed.
    assert.strictEqual(info.otherInstallations.length, 1);
    assert.match(
      formatCliAboutInfo(info),
      /bundled with the VS Code extension/
    );
  });
});
