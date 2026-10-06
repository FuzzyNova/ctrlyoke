import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { readJsonFile } from "../../utils/FileSystemUtils";

suite("FileSystemUtils", () => {
  test("reads and parses JSON without a VS Code host", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-json-"));
    const filePath = path.join(directory, "data.json");
    try {
      await fs.writeFile(filePath, JSON.stringify({ value: 42 }), "utf8");
      assert.deepStrictEqual(await readJsonFile(filePath), { value: 42 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
