import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, suite, test } from "mocha";
import { getGitIgnoredPaths } from "../utils/GitUtils";
import { resolveSourceRuntimeArtifacts } from "../utils/SourceRuntimeArtifactResolver";

suite("SourceRuntimeArtifactResolver", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await fs.promises.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });

  test("returns ignored files but not tracked files", async () => {
    const sourceRoot = createRepository();
    const executionRoot = createTemporaryDirectory("execution");
    const ignoredPath = writeSourceFile(sourceRoot, "runtime/ignored.log");
    writeSourceFile(sourceRoot, "runtime/tracked.log");
    git(sourceRoot, "add", "-f", "runtime/tracked.log");
    git(sourceRoot, "commit", "-m", "add tracked runtime file");

    const result = await resolveSourceRuntimeArtifacts(
      sourceRoot,
      executionRoot,
      new Set([ignoredPath, "runtime/ignored.log", "runtime/tracked.log"])
    );

    assert.deepStrictEqual(
      result,
      new Map([
        [ignoredPath, ignoredPath],
        ["runtime/ignored.log", ignoredPath],
      ])
    );
    assert.strictEqual(result.has("runtime/tracked.log"), false);
  });

  test("does not import a tracked file absent from the execution checkout", async () => {
    const sourceRoot = createRepository();
    const executionRoot = createTemporaryDirectory("execution");
    writeSourceFile(sourceRoot, "runtime/deleted.log");
    git(sourceRoot, "add", "-f", "runtime/deleted.log");
    git(sourceRoot, "commit", "-m", "add deleted runtime file");

    const result = await resolveSourceRuntimeArtifacts(
      sourceRoot,
      executionRoot,
      new Set(["runtime/deleted.log"])
    );

    assert.deepStrictEqual(result, new Map());
  });

  test("does not import an untracked file that is not ignored", async () => {
    const sourceRoot = createRepository();
    const executionRoot = createTemporaryDirectory("execution");
    writeSourceFile(sourceRoot, "work-in-progress.log");

    const result = await resolveSourceRuntimeArtifacts(
      sourceRoot,
      executionRoot,
      new Set(["work-in-progress.log"])
    );

    assert.deepStrictEqual(result, new Map());
  });

  test("uses exactly one check-ignore subprocess for a batch", async () => {
    const sourceRoot = createRepository();
    const executionRoot = createTemporaryDirectory("execution");
    const candidates = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const referencePath = `runtime/log-${index}.log`;
      writeSourceFile(sourceRoot, referencePath);
      candidates.add(referencePath);
    }

    const tracePath = path.join(createTemporaryDirectory("trace"), "git.jsonl");
    const previousTracePath = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = tracePath;
    try {
      const result = await resolveSourceRuntimeArtifacts(
        sourceRoot,
        executionRoot,
        candidates
      );
      assert.strictEqual(result.size, candidates.size);
    } finally {
      if (previousTracePath === undefined) {
        delete process.env.GIT_TRACE2_EVENT;
      } else {
        process.env.GIT_TRACE2_EVENT = previousTracePath;
      }
    }

    const checkIgnoreCommands = fs
      .readFileSync(tracePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { event?: string; name?: string })
      .filter(
        (event) => event.event === "cmd_name" && event.name === "check-ignore"
      );
    assert.strictEqual(checkIgnoreCommands.length, 1);
  });

  test("treats check-ignore exit code 1 as no matches", async () => {
    const sourceRoot = createRepository();
    const unignoredPath = writeSourceFile(sourceRoot, "ordinary.txt");

    const result = await getGitIgnoredPaths(sourceRoot, [unignoredPath]);

    assert.deepStrictEqual(result, new Set());
  });

  test("does not spawn for empty input", async () => {
    const result = await getGitIgnoredPaths(
      path.join(os.tmpdir(), "not-a-repository"),
      []
    );

    assert.deepStrictEqual(result, new Set());
  });

  test("rejects a symlink that escapes the source checkout", async function () {
    const sourceRoot = createRepository();
    const executionRoot = createTemporaryDirectory("execution");
    const outsideRoot = createTemporaryDirectory("outside");
    const outsidePath = writeFile(outsideRoot, "outside.log", "outside\n");
    const linkPath = path.join(sourceRoot, "runtime", "escaped.log");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      fs.symlinkSync(outsidePath, linkPath, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        this.skip();
        return;
      }
      throw error;
    }

    const result = await resolveSourceRuntimeArtifacts(
      sourceRoot,
      executionRoot,
      new Set(["runtime/escaped.log"])
    );

    assert.deepStrictEqual(result, new Map());
  });

  test("short-circuits for non-worktree roots", async () => {
    const sourceRoot = createRepository();
    const ignoredPath = writeSourceFile(sourceRoot, "runtime/ignored.log");

    const sameRootResult = await resolveSourceRuntimeArtifacts(
      sourceRoot,
      sourceRoot,
      new Set([ignoredPath])
    );
    const undefinedRootResult = await resolveSourceRuntimeArtifacts(
      undefined,
      path.join(os.tmpdir(), "not-a-repository"),
      new Set([ignoredPath])
    );

    assert.deepStrictEqual(sameRootResult, new Map());
    assert.deepStrictEqual(undefinedRootResult, new Map());
  });

  function createRepository(): string {
    const repositoryRoot = createTemporaryDirectory("source");
    git(repositoryRoot, "init", "-q");
    writeFile(repositoryRoot, ".gitignore", "runtime/\n");
    git(repositoryRoot, "add", ".gitignore");
    git(repositoryRoot, "commit", "-m", "initial commit");
    return repositoryRoot;
  }

  function createTemporaryDirectory(label: string): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `ctrlyoke-${label}-`)
    );
    temporaryDirectories.push(directory);
    return directory;
  }

  function writeSourceFile(
    repositoryRoot: string,
    relativePath: string
  ): string {
    return writeFile(repositoryRoot, relativePath, `${relativePath}\n`);
  }

  function writeFile(
    root: string,
    relativePath: string,
    content: string
  ): string {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
    return absolutePath;
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
