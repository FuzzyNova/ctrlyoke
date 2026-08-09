import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  PromptFileResolver,
  type PromptFileResolution,
} from "../../core/PromptFileResolver";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";

suite("PromptFileResolver", () => {
  let workspaceRoot: string;
  let sourceDirectory: string;
  let secondaryRoot: string;
  let namedRoots: ResolverWorkspaceFolder[];

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-resolver-")
    );
    sourceDirectory = path.join(workspaceRoot, "source");
    secondaryRoot = path.join(workspaceRoot, "secondary");
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.mkdir(secondaryRoot, { recursive: true });
    namedRoots = [
      { name: "primary", fsPath: workspaceRoot },
      { name: "secondary", fsPath: secondaryRoot },
    ];
  });

  teardown(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  test("resolves an absolute path", async () => {
    const filePath = path.join(workspaceRoot, "absolute.prompt.md");
    await fs.writeFile(filePath, "  absolute content  ", "utf8");

    const result = await new PromptFileResolver({ workspaceRoot }).resolve(
      filePath
    );

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.path, filePath);
    assert.strictEqual(result.content, "  absolute content  ");
  });

  test("resolves relative to the source-definition directory", async () => {
    const sourceFile = path.join(sourceDirectory, "workflow.ctrlyoke.json");
    const promptFile = path.join(sourceDirectory, "relative.prompt.md");
    await fs.writeFile(promptFile, "source content", "utf8");

    const result = await new PromptFileResolver({ workspaceRoot }).resolve(
      "./relative.prompt.md",
      sourceFile
    );

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.path, promptFile);
  });

  test("resolves relative to the primary workspace root", async () => {
    const promptFile = path.join(workspaceRoot, "workspace.prompt.md");
    await fs.writeFile(promptFile, "workspace content", "utf8");

    const result = await new PromptFileResolver({
      workspaceRoot,
      namedRoots: [namedRoots[0]],
    }).resolve("./workspace.prompt.md", path.join(sourceDirectory, "missing.json"));

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.path, promptFile);
  });

  test("falls back to the .ctrlyoke directory", async () => {
    const promptFile = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "fallback.prompt.md"
    );
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, "fallback content", "utf8");

    const result = await new PromptFileResolver({ workspaceRoot }).resolve(
      "./fallback.prompt.md",
      path.join(sourceDirectory, "missing.json")
    );

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.path, promptFile);
  });

  test("resolves a named multi-root prefix against that root", async () => {
    const promptFile = path.join(secondaryRoot, "prompts", "named.prompt.md");
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, "named content", "utf8");

    const result = await new PromptFileResolver({
      workspaceRoot,
      namedRoots,
    }).resolve("secondary/prompts/named.prompt.md");

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.path, promptFile);
  });

  test("reports missing, empty, and resolved-with-content distinctly", async () => {
    const emptyFile = path.join(workspaceRoot, "empty.prompt.md");
    const contentFile = path.join(workspaceRoot, "content.prompt.md");
    await fs.writeFile(emptyFile, " \n\t ", "utf8");
    await fs.writeFile(contentFile, "content", "utf8");
    const resolver = new PromptFileResolver({ workspaceRoot });

    const missing = await resolver.resolve("./missing.prompt.md");
    const empty = await resolver.resolve("./empty.prompt.md");
    const content = await resolver.resolve("./content.prompt.md");

    assert.strictEqual(missing.status, "missing");
    assert.strictEqual(empty.status, "empty");
    assert.strictEqual(empty.content, " \n\t ");
    assert.strictEqual(content.status, "resolved");
    assert.strictEqual(content.content, "content");
  });

  test("returns raw content for prompt values and rejects missing references", async () => {
    const promptFile = path.join(workspaceRoot, "raw.prompt.md");
    await fs.writeFile(promptFile, "  raw content  ", "utf8");
    const resolver = new PromptFileResolver({ workspaceRoot });

    assert.strictEqual(
      await resolver.resolvePromptValue("./raw.prompt.md"),
      "  raw content  "
    );
    await assert.rejects(
      resolver.resolvePromptValue("./missing.prompt.md"),
      /could not be found/
    );
  });

  test("defers variable-backed references during static validation", async () => {
    const resolver = new PromptFileResolver({ workspaceRoot });
    await resolver.validatePromptReference("./{{name}}.prompt.md");
  });

  test("path-only callers share the same candidate result", async () => {
    const promptFile = path.join(workspaceRoot, ".ctrlyoke", "same.prompt.md");
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.writeFile(promptFile, "same content", "utf8");
    const resolver = new PromptFileResolver({ workspaceRoot });

    const asyncResolution = await resolver.resolvePath("./same.prompt.md");
    const syncResolution = resolver.resolvePathSync("./same.prompt.md");

    if (
      asyncResolution.status === "missing" ||
      syncResolution.status === "missing"
    ) {
      throw new Error("Expected the shared path to resolve");
    }

    assert.deepStrictEqual(
      { status: asyncResolution.status, path: asyncResolution.path },
      { status: syncResolution.status, path: syncResolution.path }
    );
  });

  test("skips directories and continues in candidate order", async () => {
    const directory = path.join(workspaceRoot, "directory.prompt.md");
    const fallback = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "directory.prompt.md"
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(path.dirname(fallback), { recursive: true });
    await fs.writeFile(fallback, "regular file", "utf8");

    const result: PromptFileResolution = await new PromptFileResolver({
      workspaceRoot,
    }).resolve("./directory.prompt.md");

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.path, fallback);
  });

  test("blocks relative and absolute prompt files outside trusted roots", async () => {
    const outsideFile = path.join(path.dirname(workspaceRoot), "outside.md");
    await fs.writeFile(outsideFile, "secret", "utf8");
    try {
      const resolver = new PromptFileResolver({
        workspaceRoot,
        trustedRoots: [workspaceRoot],
      });
      const sourceFile = path.join(sourceDirectory, "workflow.yaml");

      const relative = await resolver.resolve("../../outside.md", sourceFile);
      const absolute = await resolver.resolve(outsideFile, sourceFile);

      assert.strictEqual(relative.status, "missing");
      assert.strictEqual(absolute.status, "missing");
    } finally {
      await fs.rm(outsideFile, { force: true });
    }
  });

  test("ignores a source-definition directory outside trusted roots", async () => {
    const outsideDirectory = path.join(path.dirname(workspaceRoot), "workflow");
    const outsidePrompt = path.join(outsideDirectory, "prompt.md");
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(outsidePrompt, "outside", "utf8");
    try {
      const resolver = new PromptFileResolver({
        workspaceRoot,
        trustedRoots: [workspaceRoot],
      });
      const resolution = await resolver.resolve(
        "./prompt.md",
        path.join(outsideDirectory, "workflow.yaml")
      );

      assert.strictEqual(resolution.status, "missing");
      assert.ok(
        resolution.candidates.every(
          (candidate) => !candidate.startsWith(outsideDirectory)
        )
      );
    } finally {
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});
