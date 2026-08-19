import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { suite, teardown, test } from "mocha";
import { RuntimeTrustedRootRegistry } from "../../utils/RuntimeTrustedRootRegistry";

suite("RuntimeTrustedRootRegistry", () => {
  const temporaryDirectories: string[] = [];

  teardown(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true }))
    );
  });

  async function repository(): Promise<string> {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-runtime-trust-")
    );
    temporaryDirectories.push(directory);
    execFileSync("git", ["init", directory], { stdio: "ignore" });
    return directory;
  }

  test("keeps owner-token references until every handle releases", async () => {
    const root = await repository();
    const registry = new RuntimeTrustedRootRegistry();
    const first = await registry.register({
      rootPath: root,
      ownerToken: "owner",
    });
    const second = await registry.register({
      rootPath: root,
      ownerToken: "owner",
    });

    assert.deepStrictEqual(registry.getRoots(), [path.resolve(root)]);
    first.release();
    assert.deepStrictEqual(registry.getRoots(), [path.resolve(root)]);
    second.release();
    assert.deepStrictEqual(registry.getRoots(), []);
  });

  test("drops a root when its directory disappears", async () => {
    const root = await repository();
    const registry = new RuntimeTrustedRootRegistry();
    await registry.register({ rootPath: root, ownerToken: "owner" });
    await fs.rm(root, { recursive: true, force: true });
    assert.deepStrictEqual(registry.getRoots(), []);
  });
});
