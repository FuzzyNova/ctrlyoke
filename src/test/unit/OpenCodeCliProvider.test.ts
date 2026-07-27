import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import { OpenCodeLogParser } from "../../core/harness/opencode/OpenCodeLogParser";
import { CliResponseCollector } from "../../core/harness/shared/CliResponseCollector";

suite("OpenCodeCliProvider", () => {
  test("maps headless stdout like interactive export output without invoking export", async () => {
    const sessionId = "ses_golden";
    const stdoutEvents = [
      {
        type: "text",
        sessionID: sessionId,
        timestamp: 1000,
        part: { text: "The answer" },
      },
      {
        type: "tool_use",
        sessionID: sessionId,
        timestamp: 1002,
        part: {
          tool: "write",
          callID: "call_write",
          state: {
            status: "completed",
            input: { filePath: "src/generated.ts", content: "export {};" },
            output: "",
            time: { start: 1002, end: 1003 },
          },
        },
      },
      {
        type: "step_finish",
        sessionID: sessionId,
        timestamp: 1004,
        part: {
          reason: "stop",
          tokens: {
            input: 120,
            output: 30,
            total: 150,
            cache: { read: 10 },
          },
        },
      },
    ];
    const interactiveExport = {
      info: { id: sessionId },
      messages: [
        {
          info: { role: "assistant", time: { created: 1000 } },
          parts: [
            {
              type: "text",
              id: "part_text",
              sessionID: sessionId,
              messageID: "message_1",
              text: "The answer",
              time: { start: 1000, end: 1001 },
            },
            {
              type: "tool",
              id: "part_write",
              sessionID: sessionId,
              messageID: "message_1",
              tool: "write",
              callID: "call_write",
              state: {
                status: "completed",
                input: {
                  filePath: "src/generated.ts",
                  content: "export {};",
                },
                output: "",
                time: { start: 1002, end: 1003 },
              },
            },
            {
              type: "step-finish",
              id: "part_finish",
              sessionID: sessionId,
              messageID: "message_1",
              reason: "stop",
              tokens: {
                input: 120,
                output: 30,
                total: 150,
                cache: { read: 10 },
              },
            },
          ],
        },
      ],
    };

    let exportCalls = 0;
    const logParser = new OpenCodeLogParser(
      () => 200000,
      async () => {
        exportCalls += 1;
        return JSON.stringify({ info: { id: sessionId }, messages: [] });
      }
    );
    const provider = new OpenCodeCliProvider();
    Object.defineProperty(provider, "logParser", { value: logParser });
    const collector = new CliResponseCollector({
      provider,
      hostCallbacks: {
        logResponse: () => {},
        onResponseComplete: () => {},
      },
    });

    const collected = await collector.collectHeadlessResponse({
      stdout: [
        "OpenCode JSONL",
        ...stdoutEvents.map((event) => JSON.stringify(event)),
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      promptForSessionLog: "golden prompt",
      executionStartTime: new Date(1000),
    });
    const interactiveEvents = (logParser as any).extractNewEventsFromExport(
      interactiveExport
    );
    const interactiveOutput = logParser.extractResponse(interactiveEvents);

    assert.deepStrictEqual(collected.parsedOutput, interactiveOutput);
    assert.strictEqual(provider.headlessSource, "stdout");
    assert.strictEqual(
      provider.extractSessionIdFromStdout?.(
        stdoutEvents.map((event) => JSON.stringify(event)).join("\n")
      ),
      sessionId
    );
    assert.strictEqual(exportCalls, 0);
  });

  test("writes a temporary plugin gitignore and cleans plugin artifacts after a run", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-provider-")
    );
    const extensionPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-extension-")
    );
    const provider = new OpenCodeCliProvider();

    try {
      await fs.mkdir(path.join(extensionPath, "out", "scripts"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(
          extensionPath,
          "out",
          "scripts",
          "ctrlyoke-opencode-plugin.ts"
        ),
        "export default {};\n",
        "utf-8"
      );

      await provider.buildCliArgs(
        { prompt: "test" },
        true,
        extensionPath,
        workspaceRoot,
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: {
            hooks: [{ event: "stop", command: "echo cleanup" }],
          },
        } as any
      );

      const pluginDir = path.join(workspaceRoot, ".opencode", "plugin");
      const pluginPath = path.join(pluginDir, "ctrlyoke-completion-hook.ts");
      const sidecarPath = path.join(pluginDir, "ctrlyoke-hooks.json");
      const gitignorePath = path.join(pluginDir, ".gitignore");

      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      assert.ok(gitignoreContent.includes("ctrlyoke-completion-hook.ts"));
      assert.ok(gitignoreContent.includes("ctrlyoke-hooks.json"));
      await fs.access(pluginPath);
      await fs.access(sidecarPath);

      for (const artifactPath of provider.getAdditionalCleanupFilePaths(
        workspaceRoot
      )) {
        await fs.unlink(artifactPath).catch(() => {});
      }
      await provider.cleanupWorkspaceArtifacts(workspaceRoot);

      await assert.rejects(fs.access(pluginPath), /ENOENT/);
      await assert.rejects(fs.access(sidecarPath), /ENOENT/);
      await assert.rejects(fs.access(gitignorePath), /ENOENT/);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(extensionPath, { recursive: true, force: true });
    }
  });

  test("preserves a user-owned plugin gitignore during cleanup", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-provider-")
    );
    const extensionPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-extension-")
    );
    const provider = new OpenCodeCliProvider();

    try {
      const pluginDir = path.join(workspaceRoot, ".opencode", "plugin");
      await fs.mkdir(pluginDir, { recursive: true });
      const gitignorePath = path.join(pluginDir, ".gitignore");
      const userGitignore = "# user-owned\n*.log\n";
      await fs.writeFile(gitignorePath, userGitignore, "utf-8");
      await fs.mkdir(path.join(extensionPath, "out", "scripts"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(
          extensionPath,
          "out",
          "scripts",
          "ctrlyoke-opencode-plugin.ts"
        ),
        "export default {};\n",
        "utf-8"
      );

      await provider.buildCliArgs(
        { prompt: "test" },
        true,
        extensionPath,
        workspaceRoot,
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: {
            hooks: [{ event: "stop", command: "echo cleanup" }],
          },
        } as any
      );

      for (const artifactPath of provider.getAdditionalCleanupFilePaths(
        workspaceRoot
      )) {
        await fs.unlink(artifactPath).catch(() => {});
      }
      await provider.cleanupWorkspaceArtifacts(workspaceRoot);

      assert.strictEqual(
        await fs.readFile(gitignorePath, "utf-8"),
        userGitignore
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(extensionPath, { recursive: true, force: true });
    }
  });

  test("formatFileReference drops the @ prefix so the TUI cannot reinterpret it as an agent mention", () => {
    const provider = new OpenCodeCliProvider();

    assert.strictEqual(
      provider.formatFileReference(".ctrlyoke/temp/prompt.md"),
      ".ctrlyoke/temp/prompt.md"
    );
    assert.strictEqual(
      provider.formatFileReference('"path with space/a.ts"'),
      '"path with space/a.ts"'
    );
  });
});
