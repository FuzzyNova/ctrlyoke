import * as assert from "assert";
import { findSymbolRange } from "../../utils/SymbolRangeFinder";

/**
 * Pure-function tests for provider-independent symbol range discovery. These
 * exercise the heuristics that let `#sym:` references expand in the CLI without
 * VS Code's symbol provider.
 */
suite("SymbolRangeFinder Tests", () => {
  const lines = (...l: string[]): string => l.join("\n");

  test("brace method with same-line body brace", () => {
    const content = lines(
      "export class Foo {", // 1
      "  bar(): void {", //    2
      "    doThing();", //     3
      "    again();", //       4
      "  }", //                5
      "}" //                   6
    );
    assert.deepStrictEqual(findSymbolRange(content, "bar", 2, ".ts"), {
      startLine: 2,
      endLine: 5,
    });
  });

  test("inline object-type braces in signature do not close the block early", () => {
    const content = lines(
      "class Foo {", //                      1
      "  bar(opts: { a: number }): void {", //2
      "    use(opts);", //                    3
      "  }", //                               4
      "}" //                                  5
    );
    assert.deepStrictEqual(findSymbolRange(content, "bar", 2, ".ts"), {
      startLine: 2,
      endLine: 4,
    });
  });

  test("multi-line signature with body brace several lines down", () => {
    const content = lines(
      "function foo(", //   1
      "  a: number,", //    2
      "  b: string,", //    3
      "): void {", //       4
      "  return;", //       5
      "}" //                6
    );
    assert.deepStrictEqual(findSymbolRange(content, "foo", 1, ".ts"), {
      startLine: 1,
      endLine: 6,
    });
  });

  test("Allman-style brace on the next line", () => {
    const content = lines(
      "void foo()", // 1
      "{", //          2
      "  work();", //  3
      "}" //           4
    );
    assert.deepStrictEqual(findSymbolRange(content, "foo", 1, ".cs"), {
      startLine: 1,
      endLine: 4,
    });
  });

  test("interface property (no brace body) resolves to a single line", () => {
    const content = lines(
      "interface Opts {", // 1
      "  name: string;", //  2
      "  count: number;", // 3
      "}" //                 4
    );
    assert.deepStrictEqual(findSymbolRange(content, "name", 2, ".ts"), {
      startLine: 2,
      endLine: 2,
    });
  });

  test("single-statement const resolves to a single line", () => {
    const content = lines(
      "const a = 1;", //          1
      "export const x = f(2);", //2
      "const b = 3;" //          3
    );
    assert.deepStrictEqual(findSymbolRange(content, "x", 2, ".ts"), {
      startLine: 2,
      endLine: 2,
    });
  });

  test("multi-line object literal const keeps its full extent", () => {
    const content = lines(
      "const config = {", // 1
      "  a: 1,", //          2
      "  b: 2,", //          3
      "};" //                4
    );
    assert.deepStrictEqual(findSymbolRange(content, "config", 1, ".ts"), {
      startLine: 1,
      endLine: 4,
    });
  });

  test("python function uses indentation, not braces", () => {
    const content = lines(
      "def foo(self):", //         1
      "    data = {'a': 1}", //    2 (brace here must NOT matter)
      "    return data", //        3
      "", //                       4
      "def bar(self):", //         5
      "    return 2" //            6
    );
    assert.deepStrictEqual(findSymbolRange(content, "foo", 1, ".py"), {
      startLine: 1,
      endLine: 3,
    });
  });

  test("symbol name with trailing () still matches", () => {
    const content = lines(
      "class C {", //          1
      "  expandContext() {", //2
      "    return 1;", //      3
      "  }", //                4
      "}" //                   5
    );
    assert.deepStrictEqual(
      findSymbolRange(content, "expandContext()", 2, ".ts"),
      { startLine: 2, endLine: 4 }
    );
  });

  test("drifted start line falls back to locating the symbol by name", () => {
    const content = lines(
      "// a comment was added at the top", // 1
      "class C {", //                         2
      "  bar(): void {", //                   3
      "    work();", //                       4
      "  }", //                               5
      "}" //                                  6
    );
    // Reference says line 2 (stale), real declaration is line 3.
    assert.deepStrictEqual(findSymbolRange(content, "bar", 2, ".ts"), {
      startLine: 3,
      endLine: 5,
    });
  });
});
