import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { readIncrementalJsonl } from "../../core/harness/shared/IncrementalJsonlReader";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

interface TestRecord {
  id: string;
}

function isTestRecord(value: unknown): value is TestRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  );
}

suite("IncrementalJsonlReader", () => {
  let tempDir: string;

  setup(() => {
    tempDir = makeTempDir("incremental-jsonl-reader-");
  });

  teardown(() => removeTempDir(tempDir));

  test("reads only bytes appended after the supplied offset", async () => {
    const filePath = path.join(tempDir, "child.jsonl");
    const prefix = '{"id":"already-read"}\n';
    fs.writeFileSync(filePath, `${prefix}{"id":"new"}\n`);

    const result = await readIncrementalJsonl(
      filePath,
      Buffer.byteLength(prefix),
      isTestRecord
    );

    assert.deepStrictEqual(result.records, [{ id: "new" }]);
    assert.strictEqual(result.nextOffset, fs.statSync(filePath).size);
  });

  test("holds a partial trailing line until its newline arrives", async () => {
    const filePath = path.join(tempDir, "child.jsonl");
    fs.writeFileSync(filePath, '{"id":"held"');

    const partial = await readIncrementalJsonl(filePath, 0, isTestRecord);
    assert.deepStrictEqual(partial.records, []);
    assert.strictEqual(partial.nextOffset, 0);

    fs.appendFileSync(filePath, "}\n");
    const complete = await readIncrementalJsonl(
      filePath,
      partial.nextOffset,
      isTestRecord
    );
    assert.deepStrictEqual(complete.records, [{ id: "held" }]);
    assert.strictEqual(complete.nextOffset, fs.statSync(filePath).size);
  });

  test("skips malformed complete lines", async () => {
    const filePath = path.join(tempDir, "child.jsonl");
    fs.writeFileSync(filePath, '{invalid}\n{"id":"valid"}\n');

    const result = await readIncrementalJsonl(filePath, 0, isTestRecord);

    assert.deepStrictEqual(result.records, [{ id: "valid" }]);
    assert.strictEqual(result.nextOffset, fs.statSync(filePath).size);
  });

  test("returns the unchanged offset for a missing file", async () => {
    const result = await readIncrementalJsonl(
      path.join(tempDir, "missing.jsonl"),
      17,
      isTestRecord
    );

    assert.deepStrictEqual(result, { records: [], nextOffset: 17 });
  });
});
