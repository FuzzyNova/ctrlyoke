import * as assert from "assert";
import {
  finiteNumber,
  isRecord,
  isStringArray,
  parseFiniteNumber,
} from "../../utils/JsonTypeGuards";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePrivateDirectory } from "../../utils/PrivateFileModes";

suite("JsonTypeGuards", () => {
  suite("isStringArray", () => {
    test("accepts an empty array and rejects mixed arrays and non-arrays", () => {
      assert.strictEqual(isStringArray([]), true);
      assert.strictEqual(isStringArray(["text", 1]), false);
      assert.strictEqual(isStringArray("text"), false);
    });
  });

  suite("isRecord", () => {
    test("accepts non-null, non-array objects including class instances", () => {
      class Example {}

      assert.strictEqual(isRecord(null), false);
      assert.strictEqual(isRecord([]), false);
      assert.strictEqual(isRecord(new Example()), true);
      assert.strictEqual(isRecord({}), true);
    });
  });

  suite("finiteNumber", () => {
    test("accepts only finite numbers", () => {
      assert.strictEqual(finiteNumber(12), 12);
      assert.strictEqual(finiteNumber(NaN), undefined);
      assert.strictEqual(finiteNumber(Infinity), undefined);
      assert.strictEqual(finiteNumber("12"), undefined);
      assert.strictEqual(finiteNumber(" "), undefined);
      assert.strictEqual(finiteNumber(""), undefined);
      assert.strictEqual(finiteNumber("1e3"), undefined);
      assert.strictEqual(finiteNumber("abc"), undefined);
    });
  });

  suite("parseFiniteNumber", () => {
    test("accepts finite numbers and non-blank numeric strings", () => {
      assert.strictEqual(parseFiniteNumber(12), 12);
      assert.strictEqual(parseFiniteNumber(NaN), undefined);
      assert.strictEqual(parseFiniteNumber(Infinity), undefined);
      assert.strictEqual(parseFiniteNumber("12"), 12);
      assert.strictEqual(parseFiniteNumber(" "), undefined);
      assert.strictEqual(parseFiniteNumber(""), undefined);
      assert.strictEqual(parseFiniteNumber("1e3"), 1000);
      assert.strictEqual(parseFiniteNumber("abc"), undefined);
    });
  });
});

suite("PrivateFileModes", () => {
  (process.platform === "win32" ? test.skip : test)(
    "tightens an existing directory to mode 0700",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-dir-"));
      const directory = path.join(root, "loose");
      try {
        await fs.mkdir(directory, { mode: 0o777 });
        await fs.chmod(directory, 0o777);
        await ensurePrivateDirectory(directory);
        const mode = (await fs.stat(directory)).mode & 0o777;
        assert.strictEqual(mode, 0o700);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
});
