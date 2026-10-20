import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkspacePathStore } from "../../completions/WorkspacePathStore";
import { workspacePathStoreEntries } from "../helpers/workspacePathStoreEntries";

suite("WorkspacePathStore", () => {
  test("preserves file order and inserts each directory at first sight", () => {
    const store = new WorkspacePathStore();
    store.replaceAll([
      "src/z.ts",
      "README.md",
      "src/nested/a.ts",
      "src/z.ts",
      "../outside.ts",
      "",
    ]);
    assert.deepStrictEqual(
      workspacePathStoreEntries(store).map(({ relativePath }) => relativePath),
      ["src", "src/z.ts", "README.md", "src/nested", "src/nested/a.ts"]
    );
    assert.deepStrictEqual(
      workspacePathStoreEntries(store).map(({ position }) => position),
      [0, 1, 2, 3, 4]
    );
    assert.deepStrictEqual(store.entryAt(1), {
      kind: "file",
      relativePath: "src/z.ts",
      lowerPath: "src/z.ts",
      name: "z.ts",
      lowerName: "z.ts",
      parent: "src",
      lowerParent: "src",
      position: 1,
    });
  });

  test("adds paths in order and advances the version only for changes", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["one/a.ts"]);
    const version = store.version;
    store.add(["one/a.ts", "two/b.ts"]);
    assert.strictEqual(store.version, version + 1);
    assert.deepStrictEqual(store.files, ["one/a.ts", "two/b.ts"]);
    store.add("two/b.ts");
    assert.strictEqual(store.version, version + 1);
  });

  test("removeTree removes nested files and orphaned directories", () => {
    const store = new WorkspacePathStore();
    store.replaceAll([
      "src/one/deep/a.ts",
      "src/one/b.ts",
      "src/two/c.ts",
      "README.md",
    ]);
    store.removeTree("src/one");
    assert.deepStrictEqual(store.files, ["src/two/c.ts", "README.md"]);
    assert.deepStrictEqual(
      workspacePathStoreEntries(store).map(({ relativePath }) => relativePath),
      ["src/two", "src", "src/two/c.ts", "README.md"]
    );
    const version = store.version;
    store.removeTree("missing");
    assert.strictEqual(store.version, version);
  });

  test("add appends without rebuilding existing entries", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["src/a.ts"]);
    const before = workspacePathStoreEntries(store);
    store.add(["src/b.ts", "lib/c.ts"]);
    // Existing entries keep their positions, so adding costs only new paths.
    assert.deepStrictEqual(
      workspacePathStoreEntries(store).slice(0, before.length),
      before
    );
    assert.deepStrictEqual(
      workspacePathStoreEntries(store).map(({ relativePath, position }) => [
        relativePath,
        position,
      ]),
      [
        ["src", 0],
        ["src/a.ts", 1],
        ["src/b.ts", 2],
        ["lib", 3],
        ["lib/c.ts", 4],
      ]
    );
  });

  test("removeTrees removes several trees in one version step", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["a/1.ts", "b/2.ts", "c/3.ts"]);
    const version = store.version;
    store.removeTrees(["a", "c/3.ts"]);
    assert.deepStrictEqual(store.files, ["b/2.ts"]);
    assert.strictEqual(store.version, version + 1);
    store.add("a/1.ts");
    assert.deepStrictEqual(store.files, ["b/2.ts", "a/1.ts"]);
  });

  test("derives lowercase, name and parent from the path", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["Src/Deep/MixedCase.TS", "TOP.md"]);
    assert.deepStrictEqual(
      workspacePathStoreEntries(store).map(
        ({ kind, lowerPath, name, lowerName, parent, lowerParent }) => [
          kind,
          lowerPath,
          name,
          lowerName,
          parent,
          lowerParent,
        ]
      ),
      [
        ["directory", "src/deep", "Deep", "deep", "Src", "src"],
        ["directory", "src", "Src", "src", ".", "."],
        [
          "file",
          "src/deep/mixedcase.ts",
          "MixedCase.TS",
          "mixedcase.ts",
          "Src/Deep",
          "src/deep",
        ],
        ["file", "top.md", "TOP.md", "top.md", ".", "."],
      ]
    );
    assert.ok(store.hasParent(2, "Src/Deep"));
    assert.ok(!store.hasParent(2, "src/deep"));
    assert.ok(store.hasLowerParent(2, "src/deep"));
    assert.ok(store.hasLowerParent(3, "."));
    assert.ok(!store.hasLowerParent(2, "src/dee"));
    assert.strictEqual(store.fileCount, 2);
  });

  test("tracks an estimate of the heap it holds", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["a/b.ts"]);
    assert.strictEqual(
      store.estimatedBytes,
      WorkspacePathStore.estimateBytes(["a", "a/b.ts"])
    );
    store.removeTree("a");
    assert.strictEqual(store.estimatedBytes, 0);
  });

  test("grows past its initial column capacity", () => {
    const store = new WorkspacePathStore();
    const files = Array.from({ length: 5_000 }, (_, i) => `d${i % 7}/f${i}.ts`);
    store.replaceAll(files);
    assert.strictEqual(store.fileCount, 5_000);
    assert.strictEqual(store.size, 5_007);
    const last = store.entryAt(store.size - 1);
    assert.strictEqual(last.relativePath, "d1/f4999.ts");
    assert.strictEqual(last.parent, "d1");
  });

  test("normalizes Windows separators while retaining ordered multi-root paths", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["root-a\\src\\index.ts", "root-b\\README.md"]);
    assert.deepStrictEqual(store.files, [
      "root-a/src/index.ts",
      "root-b/README.md",
    ]);
  });
});
