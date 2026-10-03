import * as assert from "assert";
import * as path from "path";
import {
  findRepoForPath,
  mapRootPrefixesToRepos,
} from "../../utils/WorkspaceRepoDiscovery";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";
import type { WorkspaceRepo } from "../../types/HostedWorkspaceViewerTypes";

/**
 * Pure-function tests for the root-prefix → repo-id mapping the server ships to
 * the client. Git-spawning `discoverRepos` is exercised via the service tests
 * in `HostedWorkspaceViewerService.test.ts`; this covers the association logic
 * that used to be reverse-engineered on the client.
 */
suite("WorkspaceRepoDiscovery.mapRootPrefixesToRepos Tests", () => {
  const root = (name: string, fsPath: string): ResolverWorkspaceFolder => ({
    name,
    fsPath: path.resolve(fsPath),
  });
  const repo = (id: string, rootPath: string): WorkspaceRepo => ({
    id,
    label: id,
    rootPath: path.resolve(rootPath),
  });

  test("maps a root that IS its own repo toplevel by folder name", () => {
    const map = mapRootPrefixesToRepos(
      [root("alpha", "/ws/alpha"), root("beta", "/ws/beta")],
      [repo("alpha", "/ws/alpha"), repo("beta", "/ws/beta")]
    );
    assert.deepStrictEqual(map, { alpha: "alpha", beta: "beta" });
  });

  test("maps a root named constructor", () => {
    const map = mapRootPrefixesToRepos(
      [root("constructor", "/ws/constructor")],
      [repo("constructor", "/ws/constructor")]
    );
    assert.strictEqual(Object.hasOwn(map, "constructor"), true);
    assert.strictEqual(map.constructor, "constructor");
  });

  test("maps a root nested below its git toplevel (prefix ≠ repo id)", () => {
    // The workspace folder "frontend" lives inside the "monorepo" toplevel, so
    // its viewer-path prefix ("frontend") differs from the repo id ("monorepo").
    const map = mapRootPrefixesToRepos(
      [root("frontend", "/ws/monorepo/frontend")],
      [repo("monorepo", "/ws/monorepo")]
    );
    assert.deepStrictEqual(map, { frontend: "monorepo" });
  });

  test("maps several roots sharing one repo to that same repo id", () => {
    const map = mapRootPrefixesToRepos(
      [
        root("frontend", "/ws/monorepo/frontend"),
        root("backend", "/ws/monorepo/backend"),
      ],
      [repo("monorepo", "/ws/monorepo")]
    );
    assert.deepStrictEqual(map, {
      frontend: "monorepo",
      backend: "monorepo",
    });
  });

  test("omits a root that belongs to no discovered repo", () => {
    const map = mapRootPrefixesToRepos(
      [root("alpha", "/ws/alpha"), root("docs", "/ws/docs")],
      [repo("alpha", "/ws/alpha")]
    );
    assert.deepStrictEqual(map, { alpha: "alpha" });
  });

  test("first root wins on a duplicate folder name", () => {
    const map = mapRootPrefixesToRepos(
      [root("app", "/ws/one/app"), root("app", "/ws/two/app")],
      [repo("one", "/ws/one"), repo("two", "/ws/two")]
    );
    assert.deepStrictEqual(map, { app: "one" });
  });

  test("does not match a sibling-prefixed path outside the repo", () => {
    // "/ws/alpha-evil" must not be treated as inside "/ws/alpha".
    const map = mapRootPrefixesToRepos(
      [root("evil", "/ws/alpha-evil")],
      [repo("alpha", "/ws/alpha")]
    );
    assert.deepStrictEqual(map, {});
  });

  suite("findRepoForPath", () => {
    const repos = [repo("alpha", "/ws/alpha"), repo("beta", "/ws/beta")];

    test("matches the repo whose toplevel equals the path", () => {
      assert.strictEqual(
        findRepoForPath(path.resolve("/ws/beta"), repos)?.id,
        "beta"
      );
    });

    test("matches the repo whose toplevel contains the path", () => {
      assert.strictEqual(
        findRepoForPath(path.resolve("/ws/alpha/src/x.ts"), repos)?.id,
        "alpha"
      );
    });

    test("chooses a nested repo over its containing outer repo", () => {
      const nestedRepos = [
        repo("app", "/ws/app"),
        repo("lib", "/ws/app/vendor/lib"),
      ];
      assert.strictEqual(
        findRepoForPath("/ws/app/vendor/lib/src/x.ts", nestedRepos)?.id,
        "lib"
      );
    });

    test("returns undefined for a path in no repo", () => {
      assert.strictEqual(
        findRepoForPath(path.resolve("/ws/gamma/x.ts"), repos),
        undefined
      );
    });

    test("rejects a sibling-prefixed path", () => {
      assert.strictEqual(
        findRepoForPath(path.resolve("/ws/alpha-evil/x.ts"), repos),
        undefined
      );
    });
  });
});
