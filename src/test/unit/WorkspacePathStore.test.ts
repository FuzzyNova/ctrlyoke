import * as assert from "assert";
import { suite, test } from "mocha";
import { WorkspacePathStore } from "../../completions/WorkspacePathStore";

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
      store.entries.map(({ relativePath }) => relativePath),
      ["src", "src/z.ts", "README.md", "src/nested", "src/nested/a.ts"]
    );
    assert.deepStrictEqual(
      store.entries.map(({ position }) => position),
      [0, 1, 2, 3, 4]
    );
    assert.strictEqual(store.entries[1].lowerPath, "src/z.ts");
    assert.strictEqual(store.entries[1].lowerName, "z.ts");
    assert.strictEqual(store.entries[1].lowerParent, "src");
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
      store.entries.map(({ relativePath }) => relativePath),
      ["src/two", "src", "src/two/c.ts", "README.md"]
    );
    const version = store.version;
    store.removeTree("missing");
    assert.strictEqual(store.version, version);
  });

  test("add appends without rebuilding existing entries", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["src/a.ts"]);
    const before = store.entries.slice();
    store.add(["src/b.ts", "lib/c.ts"]);
    // Existing entry objects are untouched, so adding costs only the new paths.
    before.forEach((entry, index) =>
      assert.strictEqual(store.entries[index], entry)
    );
    assert.deepStrictEqual(
      store.entries.map(({ relativePath, position }) => [
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

  test("normalizes Windows separators while retaining ordered multi-root paths", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["root-a\\src\\index.ts", "root-b\\README.md"]);
    assert.deepStrictEqual(store.files, [
      "root-a/src/index.ts",
      "root-b/README.md",
    ]);
  });
});
