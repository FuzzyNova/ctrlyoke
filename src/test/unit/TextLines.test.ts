import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { splitLines, streamFileLines } from "../../utils/TextLines";

/**
 * U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR, spelled by code point
 * because a literal one in source is invisible in every diff and review tool.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Default highWaterMark of `fs.createReadStream`, in bytes. */
const READ_CHUNK_BYTES = 65536;

suite("TextLines", () => {
  let tempDir: string;
  let filePath: string;

  setup(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cy-lines-"));
    filePath = path.join(tempDir, "content.txt");
  });

  teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function streamOf(content: string): Promise<string[]> {
    await fs.writeFile(filePath, content, "utf8");
    const lines: string[] = [];
    for await (const line of streamFileLines(filePath)) {
      lines.push(line);
    }
    return lines;
  }

  test("never breaks on U+2028 or U+2029", async () => {
    const record = JSON.stringify({
      text: `before${LINE_SEPARATOR}middle${PARAGRAPH_SEPARATOR}after`,
    });

    const lines = await streamOf(`${record}\n${JSON.stringify({ n: 2 })}\n`);

    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], record);
    assert.deepStrictEqual(splitLines(record), [record]);
  });

  test("breaks on LF, CRLF, and a lone CR alike", async () => {
    const lines = await streamOf("lf\ncrlf\r\ncr\rlast");

    assert.deepStrictEqual(lines, ["lf", "crlf", "cr", "last"]);
    assert.deepStrictEqual(splitLines("lf\ncrlf\r\ncr\rlast"), lines);
  });

  test("joins a CRLF pair split across read chunks", async () => {
    // The CR lands as the final byte of the first chunk, so only the next
    // chunk can say whether it was a lone CR or half of a CRLF pair.
    const head = "a".repeat(READ_CHUNK_BYTES - 1);

    const lines = await streamOf(`${head}\r\ntail`);

    assert.deepStrictEqual(lines, [head, "tail"]);
  });

  test("treats a trailing break as a terminator, not an empty last line", async () => {
    assert.deepStrictEqual(await streamOf("one\ntwo\n"), ["one", "two"]);
    assert.deepStrictEqual(await streamOf("one\ntwo\r\n"), ["one", "two"]);
    assert.deepStrictEqual(await streamOf("one\ntwo\r"), ["one", "two"]);
    assert.deepStrictEqual(await streamOf(""), []);
  });

  test("yields a final line that has no trailing break", async () => {
    assert.deepStrictEqual(await streamOf('{"n":1}\n{"n":2'), [
      '{"n":1}',
      '{"n":2',
    ]);
  });

  test("preserves interior blank lines", async () => {
    assert.deepStrictEqual(await streamOf("a\n\nb\n"), ["a", "", "b"]);
  });

  test("reassembles a line that spans several read chunks", async () => {
    const long = "x".repeat(READ_CHUNK_BYTES * 3 + 17);

    const lines = await streamOf(`${long}${LINE_SEPARATOR}end\nnext\n`);

    assert.deepStrictEqual(lines, [`${long}${LINE_SEPARATOR}end`, "next"]);
  });

  test("propagates ENOENT so callers can treat a missing file as empty", async () => {
    await assert.rejects(
      async () => {
        for await (const _line of streamFileLines(
          path.join(tempDir, "missing.txt")
        )) {
          assert.fail(`unexpected line: ${_line}`);
        }
      },
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  });
});
