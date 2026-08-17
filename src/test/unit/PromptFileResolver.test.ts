import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  PromptFileResolver,
  PromptFileReferenceError,
  type PromptFileResolution,
} from "../../core/PromptFileResolver";
import type { ResolverWorkspaceFolder } from "../../platform/WorkspaceRootResolver";

suite("PromptFileResolver", () => {
  let workspaceRoot: string;
  let sourceDirectory: string;
  let secondaryRoot: string;
  let namedRoots: ResolverWorkspaceFolder[];
  let temporaryDirectories: string[];

  setup(async () => {
    temporaryDirectories = [];
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
    await Promise.all(
      temporaryDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
      )
    );
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
    }).resolve(
      "./workspace.prompt.md",
      path.join(sourceDirectory, "missing.json")
    );

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

  test("guides old workspace run-history references to priorContext", async () => {
    const resolver = new PromptFileResolver({ workspaceRoot });

    await assert.rejects(
      resolver.resolvePromptValue(
        "./.ctrlyoke/.runs/workflow/run/manifest.json"
      ),
      /priorContext: \{ workflowKey, runRef \}/
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

  test("resolves an ignored source-side prompt in relative and absolute forms", async () => {
    const sourceRoot = await createSourceRepository();
    const sourcePrompt = path.join(sourceRoot, "runtime", "source.prompt.md");
    await writeFile(sourcePrompt, "source content");
    const resolver = createWorktreeResolver(sourceRoot);
    const sourceDefinitionPath = path.join(workspaceRoot, "workflow.yaml");

    assert.strictEqual(
      await resolver.resolvePromptValue(
        "./runtime/source.prompt.md",
        sourceDefinitionPath
      ),
      "source content"
    );
    assert.strictEqual(
      await resolver.resolvePromptValue(sourcePrompt, sourceDefinitionPath),
      "source content"
    );
  });

  test("prefers the execution checkout when both copies exist", async () => {
    const sourceRoot = await createSourceRepository();
    const sourcePrompt = path.join(sourceRoot, "runtime", "same.prompt.md");
    await writeFile(sourcePrompt, "source content");
    const executionPrompt = path.join(
      workspaceRoot,
      "runtime",
      "same.prompt.md"
    );
    await writeFile(executionPrompt, "execution content");

    const result = await createWorktreeResolver(sourceRoot).resolvePromptValue(
      "./runtime/same.prompt.md",
      path.join(workspaceRoot, "workflow.yaml")
    );

    assert.strictEqual(result, "execution content");
  });

  test("does not import a tracked source file that is absent from the worktree", async () => {
    const sourceRoot = await createSourceRepository();
    const trackedPrompt = path.join(sourceRoot, "runtime", "tracked.prompt.md");
    await writeFile(trackedPrompt, "tracked content");
    git(sourceRoot, "add", "-f", "runtime/tracked.prompt.md");
    git(sourceRoot, "commit", "-m", "add tracked prompt");

    await assert.rejects(
      createWorktreeResolver(sourceRoot).resolvePromptValue(
        "./runtime/tracked.prompt.md",
        path.join(workspaceRoot, "workflow.yaml")
      ),
      (error: unknown) =>
        error instanceof PromptFileReferenceError &&
        /could not be found/.test(error.message)
    );
  });

  test("keeps a source-side file outside the source checkout blocked", async () => {
    const sourceRoot = await createSourceRepository();
    const outsidePrompt = path.join(
      path.dirname(sourceRoot),
      "outside-source.prompt.md"
    );
    await writeFile(outsidePrompt, "outside content");
    try {
      await assert.rejects(
        createWorktreeResolver(sourceRoot).resolvePromptValue(outsidePrompt),
        /could not be found/
      );
    } finally {
      await fs.rm(outsidePrompt, { force: true });
    }
  });

  test("keeps sync candidates identical apart from the source-side entry", async () => {
    const sourceRoot = await createSourceRepository();
    const sourcePrompt = path.join(sourceRoot, "runtime", "candidate.prompt.md");
    const sourceDefinitionPath = path.join(workspaceRoot, "workflow.yaml");
    const resolver = createWorktreeResolver(sourceRoot);

    const asyncResolution = await resolver.resolvePath(
      "./runtime/candidate.prompt.md",
      sourceDefinitionPath
    );
    const syncResolution = resolver.resolvePathSync(
      "./runtime/candidate.prompt.md",
      sourceDefinitionPath
    );

    assert.deepStrictEqual(
      asyncResolution.candidates.filter(
        (candidate) => candidate !== sourcePrompt
      ),
      syncResolution.candidates
    );
  });

  test("does not invoke Git for a non-worktree resolution", async () => {
    const tracePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-git-trace-")),
      "git.jsonl"
    );
    temporaryDirectories.push(path.dirname(tracePath));
    const previousTracePath = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = tracePath;
    try {
      await assert.rejects(
        new PromptFileResolver({ workspaceRoot }).resolvePromptValue(
          "./missing.prompt.md"
        ),
        /could not be found/
      );
    } finally {
      if (previousTracePath === undefined) {
        delete process.env.GIT_TRACE2_EVENT;
      } else {
        process.env.GIT_TRACE2_EVENT = previousTracePath;
      }
    }

    assert.strictEqual(
      await fs
        .access(tracePath)
        .then(() => true)
        .catch(() => false),
      false
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

  test("allows a UI prompt-file read from its own state root without widening workspace roots", async () => {
    const ownStateRoot = path.join(
      path.dirname(workspaceRoot),
      "ctrlyoke-state"
    );
    const statePrompt = path.join(ownStateRoot, "run", "prior.prompt.md");
    await fs.mkdir(path.dirname(statePrompt), { recursive: true });
    await fs.writeFile(statePrompt, "prior output", "utf8");

    try {
      const resolver = new PromptFileResolver({
        workspaceRoot,
        trustedRoots: [workspaceRoot],
        ownStateRoots: [ownStateRoot],
      });
      const resolution = await resolver.resolve(statePrompt);

      assert.strictEqual(resolution.status, "resolved");
      assert.strictEqual(resolution.path, statePrompt);
    } finally {
      await fs.rm(ownStateRoot, { recursive: true, force: true });
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

  test("fails closed for workflow-relative refs with an outside definition", async () => {
    const promptFile = path.join(workspaceRoot, "prompt.md");
    await fs.writeFile(promptFile, "execution content", "utf8");
    const resolver = new PromptFileResolver({
      workspaceRoot,
      trustedRoots: [workspaceRoot],
      allowWorkflowRelativeReferences: false,
    });

    const resolution = await resolver.resolve(
      "./prompt.md",
      path.join(path.dirname(workspaceRoot), "outside", "workflow.yaml")
    );

    assert.strictEqual(resolution.status, "missing");
    assert.deepStrictEqual(resolution.candidates, []);
  });

  function createWorktreeResolver(sourceCheckoutRoot: string): PromptFileResolver {
    return new PromptFileResolver({
      workspaceRoot,
      trustedRoots: [workspaceRoot],
      sourceCheckoutRoot,
    });
  }

  async function createSourceRepository(): Promise<string> {
    const sourceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-source-checkout-")
    );
    temporaryDirectories.push(sourceRoot);
    await writeFile(path.join(sourceRoot, ".gitignore"), "runtime/\n");
    git(sourceRoot, "init", "-q");
    git(sourceRoot, "add", ".gitignore");
    git(sourceRoot, "commit", "-m", "initial commit");
    return sourceRoot;
  }

  async function writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  function git(repositoryRoot: string, ...args: string[]): void {
    const gitArgs =
      args[0] === "commit"
        ? [
            "-c",
            "user.name=ctrlyoke-test",
            "-c",
            "user.email=ctrlyoke-test@example.com",
            ...args,
          ]
        : args;
    execFileSync("git", ["-C", repositoryRoot, ...gitArgs], {
      stdio: "ignore",
    });
  }
});
