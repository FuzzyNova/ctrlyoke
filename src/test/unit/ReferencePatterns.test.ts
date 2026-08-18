import * as assert from "assert";
import { suite, test } from "mocha";
import { createReferencePatterns } from "../../utils/ReferencePatterns";

/** Collect capture group 1 for every match of `pattern` in `text`. */
function paths(pattern: RegExp, text: string): string[] {
  const regex = new RegExp(pattern.source, pattern.flags);
  return [...text.matchAll(regex)].map((match) => match[1]);
}

suite("ReferencePatterns", () => {
  test("returns a fresh table so lastIndex never leaks between callers", () => {
    const first = createReferencePatterns();
    const second = createReferencePatterns();
    assert.notStrictEqual(first.fullFile, second.fullFile);

    first.fullFile.exec("@src/foo.ts");
    assert.strictEqual(second.fullFile.lastIndex, 0);
  });

  suite("fullFile", () => {
    test("matches an ordinary unquoted path", () => {
      const { fullFile } = createReferencePatterns();
      assert.deepStrictEqual(paths(fullFile, "see @src/foo.ts here"), [
        "src/foo.ts",
      ]);
    });

    test("keeps a dotted directory segment in the path", () => {
      const { fullFile } = createReferencePatterns();
      assert.deepStrictEqual(paths(fullFile, "@src/my.dir/file.ts"), [
        "src/my.dir/file.ts",
      ]);
    });

    // Regression: `(?!\/)` blocked only a literal slash, so the
    // `[a-zA-Z0-9]+` quantifier backtracked one character, saw a
    // non-slash ahead, and matched the truncated path `dir/file.t`.
    test("declines a dotted path with a trailing slash instead of truncating it", () => {
      const { fullFile } = createReferencePatterns();
      const matches = paths(fullFile, "@dir/file.ts/");
      assert.ok(
        !matches.some((value) => value.startsWith("dir/file.t")),
        `must not produce a truncated path, got ${JSON.stringify(matches)}`
      );
      assert.deepStrictEqual(matches, []);
    });

    test("declines an extensionless path under a dotted directory", () => {
      const { fullFile } = createReferencePatterns();
      assert.deepStrictEqual(paths(fullFile, "@node_modules/.bin/tsc"), []);
    });

    test("declines a one-character extension with a trailing slash", () => {
      const { fullFile } = createReferencePatterns();
      assert.deepStrictEqual(paths(fullFile, "@dir.d/"), []);
    });

    test("does not fire mid-word or inside an email address", () => {
      const { fullFile } = createReferencePatterns();
      assert.deepStrictEqual(paths(fullFile, "mail nathan@gmail.com now"), []);
    });

    test("keeps an embedded @ inside a single reference", () => {
      const { fullFile } = createReferencePatterns();
      assert.deepStrictEqual(paths(fullFile, "@myimage@512x512.png"), [
        "myimage@512x512.png",
      ]);
    });
  });

  suite("directory", () => {
    test("claims the whole token when a dotted path ends in a slash", () => {
      const { directory } = createReferencePatterns();
      assert.deepStrictEqual(paths(directory, "@dir/file.ts/"), [
        "dir/file.ts/",
      ]);
    });

    test("claims an extensionless nested path", () => {
      const { directory } = createReferencePatterns();
      assert.deepStrictEqual(paths(directory, "@node_modules/.bin/tsc"), [
        "node_modules/.bin/",
      ]);
    });
  });

  suite("quoted variants", () => {
    test("matches a quoted path containing spaces", () => {
      const { fullFileQuoted, directoryQuoted } = createReferencePatterns();
      assert.deepStrictEqual(paths(fullFileQuoted, '@"my repo/a b.ts"'), [
        "my repo/a b.ts",
      ]);
      assert.deepStrictEqual(paths(directoryQuoted, '@"my repo/dir/"'), [
        "my repo/dir/",
      ]);
    });
  });

  suite("lineRange", () => {
    test("captures a bare path in group 2 and the range in 3-4", () => {
      const { lineRange } = createReferencePatterns();
      const match = new RegExp(lineRange.source).exec(
        "#selection:src/foo.ts:10-20"
      );
      assert.ok(match);
      assert.strictEqual(match[1], undefined);
      assert.strictEqual(match[2], "src/foo.ts");
      assert.strictEqual(match[3], "10");
      assert.strictEqual(match[4], "20");
    });

    test("captures a quoted path in group 1", () => {
      const { lineRange } = createReferencePatterns();
      const match = new RegExp(lineRange.source).exec(
        '#selection:"my repo/a.ts":1-5'
      );
      assert.ok(match);
      assert.strictEqual(match[1], "my repo/a.ts");
      assert.strictEqual(match[2], undefined);
      assert.strictEqual(match[3], "1");
      assert.strictEqual(match[4], "5");
    });
  });

  suite("symbol", () => {
    test("captures kind, path, name, and range", () => {
      const { symbol } = createReferencePatterns();
      const match = new RegExp(symbol.source).exec(
        "#sym.function:src/extension.ts:activate:14-36"
      );
      assert.ok(match);
      assert.strictEqual(match[1], "function");
      assert.strictEqual(match[3], "src/extension.ts");
      assert.strictEqual(match[5], "activate");
      assert.strictEqual(match[6], "14");
      assert.strictEqual(match[7], "36");
    });

    test("captures quoted path and name without a kind", () => {
      const { symbol } = createReferencePatterns();
      const match = new RegExp(symbol.source).exec(
        '#sym:"C:/dev/my repo/a.ts":"get value":14-36'
      );
      assert.ok(match);
      assert.strictEqual(match[1], undefined);
      assert.strictEqual(match[2], "C:/dev/my repo/a.ts");
      assert.strictEqual(match[4], "get value");
    });
  });
});
