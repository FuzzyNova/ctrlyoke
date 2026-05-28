import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { CodexCliProvider } from "../../flightpath/harness/codex/CodexCliProvider";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeWorkflowContext(resumeSession?: boolean): {
  promptIndex: number;
  allPrompts: never[];
  resolvedProperties: { resumeSession?: boolean };
} {
  return {
    promptIndex: 0,
    allPrompts: [],
    resolvedProperties: { resumeSession },
  };
}

// ============================================================================

suite("CodexCliProvider", () => {
  suite("buildCliSuffix", () => {
    const provider = new CodexCliProvider();

    test("returns ['resume', sessionId] when resumeSession=true and sessionId is set", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(true)
      );
      assert.deepStrictEqual(result, ["resume", "thread_abc123"]);
    });

    test("returns [] when resumeSession=true but sessionId is undefined", () => {
      const result = provider.buildCliSuffix(
        undefined,
        makeWorkflowContext(true)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when resumeSession=false", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(false)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when resumeSession is undefined", () => {
      const result = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(undefined)
      );
      assert.deepStrictEqual(result, []);
    });

    test("returns [] when workflowContext is undefined", () => {
      const result = provider.buildCliSuffix("thread_abc123", undefined);
      assert.deepStrictEqual(result, []);
    });
  });

  suite("buildCliArgs resume ordering", () => {
    const provider = new CodexCliProvider();

    test("does not include 'resume' token in buildCliArgs output when resumeSession=true", async () => {
      // The "resume" subcommand must NOT be added by buildCliArgs — it belongs in
      // buildCliSuffix so it appears after all global flags (hooks, permissions).
      const args = await provider.buildCliArgs(
        {} as any,
        true, // interactive
        "/ext",
        "/workspace",
        "thread_abc123",
        makeWorkflowContext(true) as any
      );
      assert.ok(
        !args.includes("resume"),
        `buildCliArgs must not include 'resume' (got: ${JSON.stringify(args)})`
      );
    });

    test("combined arg order puts resume after hook args", () => {
      // Simulate the CliIntegration assembly: baseArgs → hookArgs pushed → suffix appended
      const baseArgs = ["--model", "gpt-5.2-codex", "--add-dir", "/workspace"];
      const hookArgs = ["--enable", "hooks", "-c", "hooks.state={...}"];
      const permissionArgs = ["--approval-policy=auto"];

      baseArgs.push(...hookArgs);
      baseArgs.push(...permissionArgs);

      const suffixArgs = provider.buildCliSuffix(
        "thread_abc123",
        makeWorkflowContext(true)
      );
      baseArgs.push(...suffixArgs);

      const resumeIndex = baseArgs.indexOf("resume");
      const enableIndex = baseArgs.indexOf("--enable");
      const configIndex = baseArgs.indexOf("-c");

      assert.ok(resumeIndex > -1, "resume must be present");
      assert.ok(enableIndex > -1, "--enable must be present");
      assert.ok(configIndex > -1, "-c must be present");

      assert.ok(
        resumeIndex > enableIndex,
        `'resume' (index ${resumeIndex}) must appear after '--enable' (index ${enableIndex})`
      );
      assert.ok(
        resumeIndex > configIndex,
        `'resume' (index ${resumeIndex}) must appear after '-c' (index ${configIndex})`
      );

      // Session ID immediately follows "resume"
      assert.strictEqual(
        baseArgs[resumeIndex + 1],
        "thread_abc123",
        "session ID must immediately follow 'resume'"
      );
    });

    test("interactive resumed command puts global hook trust before resume and prompt after session ID", () => {
      const baseArgs = ["--model", "gpt-5.2-codex", "--add-dir", "/workspace"];
      const hookArgs = ["--enable", "hooks", "-c", "hooks.state={...}"];
      const permissionArgs = ["--approval-policy=auto"];

      baseArgs.push(...hookArgs);
      baseArgs.push(...permissionArgs);
      baseArgs.push(
        ...provider.buildCliSuffix("thread_abc123", makeWorkflowContext(true))
      );

      const result = provider.buildInteractiveArgs(baseArgs, "continue work");

      assert.deepStrictEqual(result, [
        "--model",
        "gpt-5.2-codex",
        "--add-dir",
        "/workspace",
        "--enable",
        "hooks",
        "-c",
        "hooks.state={...}",
        "--approval-policy=auto",
        "resume",
        "thread_abc123",
        "continue work",
      ]);
    });

    test("interactive new-session command puts prompt after global args", () => {
      const result = provider.buildInteractiveArgs(
        ["--model", "gpt-5.2-codex", "--enable", "hooks"],
        "start work"
      );

      assert.deepStrictEqual(result, [
        "--model",
        "gpt-5.2-codex",
        "--enable",
        "hooks",
        "start work",
      ]);
    });
  });

  suite("buildNotificationHookArgs", () => {
    const provider = new CodexCliProvider();

    test("enables hooks with inline trust state and no bypass flag", async () => {
      const workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "codex-hook-args-")
      );
      const workingFilePath = path.join(
        workspaceRoot,
        ".flightpath",
        "wf.json"
      );

      try {
        const args = await provider.buildNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          workingFilePath,
          undefined,
          []
        );

        assert.deepStrictEqual(args.slice(0, 2), ["--enable", "hooks"]);
        assert.ok(
          !args.includes("--dangerously-bypass-hook-trust"),
          "hook trust bypass should not be emitted when inline trust state is present"
        );
        assert.ok(
          args.includes("-c"),
          "inline hooks.state trust override should remain for compatibility"
        );
      } finally {
        await provider.cleanupWorkspaceArtifacts(
          workspaceRoot,
          workingFilePath
        );
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });
});
