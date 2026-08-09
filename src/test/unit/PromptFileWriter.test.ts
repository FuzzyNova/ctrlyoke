import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { PromptFileWriter } from "../../utils/PromptFileWriter";

suite("PromptFileWriter", () => {
  let workspaceRoot: string;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-writer-")
    );
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("derives a bounded slug from the suggested name", async () => {
    const result = await new PromptFileWriter(workspaceRoot).createPromptFile(
      "body",
      "Fix flaky tests"
    );

    assert.strictEqual(result.fileName, "fix-flaky-tests.prompt.md");
    assert.strictEqual(await fs.readFile(result.filePath, "utf8"), "body");
  });

  test("uses the first six words when no suggested name is supplied", async () => {
    const result = await new PromptFileWriter(workspaceRoot).createPromptFile(
      "Review one two three four five six seven\nmore"
    );

    assert.strictEqual(
      result.fileName,
      "review-one-two-three-four-five.prompt.md"
    );
  });

  test("uses a timestamp name and preserves empty text", async () => {
    const result = await new PromptFileWriter(workspaceRoot).createPromptFile(
      ""
    );

    assert.match(result.fileName, /^\d{8}-\d{6}(?:-\d+)?.prompt\.md$/);
    assert.strictEqual(await fs.readFile(result.filePath, "utf8"), "");
  });

  test("suffixes collisions without overwriting", async () => {
    const writer = new PromptFileWriter(workspaceRoot);
    const first = await writer.createPromptFile("first", "same");
    const second = await writer.createPromptFile("second", "same");

    assert.strictEqual(second.fileName, "same-2.prompt.md");
    assert.strictEqual(await fs.readFile(first.filePath, "utf8"), "first");
    assert.strictEqual(await fs.readFile(second.filePath, "utf8"), "second");
  });

  test("two concurrent creates cannot overwrite each other", async () => {
    const writer = new PromptFileWriter(workspaceRoot);
    const results = await Promise.all([
      writer.createPromptFile("first", "concurrent"),
      writer.createPromptFile("second", "concurrent"),
    ]);

    assert.notStrictEqual(results[0].filePath, results[1].filePath);
    assert.deepStrictEqual(
      new Set(
        await Promise.all(
          results.map((result) => fs.readFile(result.filePath, "utf8"))
        )
      ),
      new Set(["first", "second"])
    );
  });

  test("creates the prompts directory on demand", async () => {
    const result = await new PromptFileWriter(workspaceRoot).createPromptFile(
      "body",
      "on-demand"
    );
    const stats = await fs.stat(path.dirname(result.filePath));
    assert.ok(stats.isDirectory());
  });

  test("rejects reserved and traversal names", async () => {
    const writer = new PromptFileWriter(workspaceRoot);
    await assert.rejects(writer.createPromptFile("body", "CON"), /Reserved/);
    await assert.rejects(
      writer.createPromptFile("body", "../outside"),
      /Unsafe/
    );
  });

  test("rejects a symlinked prompts directory", async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-writer-outside-")
    );
    try {
      await fs.mkdir(path.join(workspaceRoot, ".ctrlyoke"), {
        recursive: true,
      });
      await fs.symlink(
        outside,
        path.join(workspaceRoot, ".ctrlyoke", "prompts"),
        "junction"
      );
      await assert.rejects(
        new PromptFileWriter(workspaceRoot).createPromptFile("body", "escape"),
        /symlink|outside/i
      );
      assert.deepStrictEqual(await fs.readdir(outside), []);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
