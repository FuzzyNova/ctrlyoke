import * as assert from "assert";
import {
  TEST_SELECTION_ENV,
  filterTestFiles,
  parseTestSelectionArgs,
  readTestSelection,
  testSelectionToEnv,
} from "../suite/testSelection";

suite("parseTestSelectionArgs", () => {
  test("reads grep and file flags in every spelling", () => {
    assert.deepStrictEqual(
      parseTestSelectionArgs([
        "--grep",
        "timeline events",
        "-f",
        "unit/Foo.test.js",
        "--file=Bar",
        "src/test/unit/Baz.test.ts",
      ]),
      {
        grep: "timeline events",
        files: ["unit/Foo.test.js", "Bar", "src/test/unit/Baz.test.ts"],
      }
    );
    assert.deepStrictEqual(parseTestSelectionArgs(["-g", "x"]), {
      grep: "x",
      files: [],
    });
    assert.deepStrictEqual(parseTestSelectionArgs(["--grep=a=b"]), {
      grep: "a=b",
      files: [],
    });
  });

  test("rejects unknown options and missing values instead of running everything", () => {
    assert.throws(
      () => parseTestSelectionArgs(["--grepp", "x"]),
      /Unknown option/
    );
    assert.throws(() => parseTestSelectionArgs(["--grep"]), /needs a value/);
    assert.throws(() => parseTestSelectionArgs(["--file="]), /needs a value/);
  });
});

suite("test selection environment", () => {
  test("round-trips through the env vars the extension host reads", () => {
    const selection = { grep: "^Foo", files: ["unit/Foo.test.js"] };
    assert.deepStrictEqual(
      readTestSelection(testSelectionToEnv(selection)),
      selection
    );
  });

  test("still honours a bare MOCHA_GREP and an empty selection", () => {
    assert.deepStrictEqual(
      readTestSelection({ [TEST_SELECTION_ENV.GREP]: "x" }),
      {
        grep: "x",
        files: [],
      }
    );
    assert.deepStrictEqual(testSelectionToEnv({ files: [] }), {});
    assert.deepStrictEqual(readTestSelection({}), {
      grep: undefined,
      files: [],
    });
  });

  test("rejects a malformed file list", () => {
    assert.throws(
      () => readTestSelection({ [TEST_SELECTION_ENV.FILES]: "[1]" }),
      /JSON string array/
    );
  });
});

suite("filterTestFiles", () => {
  const files = [
    "unit/OutputHistoryManager.test.js",
    "unit/lsp/Client.test.js",
    "unit/lsp/Server.test.js",
    "promptQueue.test.js",
  ];
  const keyOf = (file: string) => file;

  test("returns every file when there is no filter", () => {
    assert.deepStrictEqual(filterTestFiles(files, [], keyOf), files);
  });

  test("matches source paths, compiled paths, basenames, stems and directories", () => {
    for (const filter of [
      "src/test/unit/OutputHistoryManager.test.ts",
      "src\\test\\unit\\OutputHistoryManager.test.ts",
      "out/test/unit/OutputHistoryManager.test.js",
      "OutputHistoryManager.test.ts",
      "outputhistorymanager",
    ]) {
      assert.deepStrictEqual(
        filterTestFiles(files, [filter], keyOf),
        ["unit/OutputHistoryManager.test.js"],
        filter
      );
    }
    assert.deepStrictEqual(filterTestFiles(files, ["unit/lsp/"], keyOf), [
      "unit/lsp/Client.test.js",
      "unit/lsp/Server.test.js",
    ]);
  });

  test("does not let a stem match a longer file name", () => {
    assert.deepStrictEqual(filterTestFiles(files, ["Client"], keyOf), [
      "unit/lsp/Client.test.js",
    ]);
    assert.throws(() => filterTestFiles(files, ["Output"], keyOf), /Output/);
  });

  test("fails when any filter matches nothing", () => {
    assert.throws(
      () => filterTestFiles(files, ["promptQueue", "Nope.test.ts"], keyOf),
      /No extension test file matches: Nope\.test\.ts/
    );
  });
});
