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
    assert.deepStrictEqual(store.entries.map(({ relativePath }) => relativePath), [
      "src",
      "src/z.ts",
      "README.md",
      "src/nested",
      "src/nested/a.ts",
    ]);
    assert.deepStrictEqual(store.entries.map(({ position }) => position), [0, 1, 2, 3, 4]);
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
    assert.deepStrictEqual(store.entries.map(({ relativePath }) => relativePath), [
      "src/two",
      "src",
      "src/two/c.ts",
      "README.md",
    ]);
    const version = store.version;
    store.removeTree("missing");
    assert.strictEqual(store.version, version);
  });

  test("normalizes Windows separators while retaining ordered multi-root paths", () => {
    const store = new WorkspacePathStore();
    store.replaceAll(["root-a\\src\\index.ts", "root-b\\README.md"]);
    assert.deepStrictEqual(store.files, ["root-a/src/index.ts", "root-b/README.md"]);
  });
});
