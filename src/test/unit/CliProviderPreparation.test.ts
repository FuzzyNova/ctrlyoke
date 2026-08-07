import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import { QwenCliProvider } from "../../core/harness/qwen/QwenCliProvider";

const fsModule = require("fs/promises") as typeof fs;

suite("CLI provider preparation", () => {
  test("plans file-backed MCP and hooks without invoking filesystem writes", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preparation-")
    );
    const originalWriteFile = fs.writeFile;
    const originalMkdir = fs.mkdir;
    let writeCount = 0;
    let mkdirCount = 0;
    fsModule.writeFile = async (...args) => {
      writeCount += 1;
      return originalWriteFile(...args);
    };
    fsModule.mkdir = async (...args) => {
      mkdirCount += 1;
      await originalMkdir(...args);
    };

    try {
      const claude = new ClaudeCliProvider();
      const copilot = new CopilotCliProvider();
      const claudeMcp = await claude.planMcpConfigArgs(
        "/ext/mcp-server.js",
        workspaceRoot
      );
      const claudeHooks = await claude.planNotificationHookArgs(
        "/ext",
        workspaceRoot,
        0,
        "workflow.ctrlyoke.json",
        undefined,
        []
      );
      const copilotMcp = await copilot.planMcpConfigArgs(
        "/ext/mcp-server.js",
        workspaceRoot
      );
      const copilotHooks = await copilot.planNotificationHookArgs(
        "/ext",
        workspaceRoot,
        0,
        "workflow.ctrlyoke.json",
        undefined,
        []
      );

      assert.strictEqual(writeCount, 0);
      assert.strictEqual(mkdirCount, 0);
      assert.strictEqual(claudeMcp.mutations.length, 1);
      assert.strictEqual(claudeHooks.mutations.length, 1);
      assert.strictEqual(copilotMcp.mutations.length, 1);
      assert.strictEqual(copilotHooks.mutations.length, 1);
      assert.ok(claudeMcp.mutations[0].path);
      assert.ok(claudeHooks.mutations[0].intendedContent);
      assert.ok(copilotMcp.mutations[0].path);
      assert.ok(copilotHooks.mutations[0].intendedContent);
    } finally {
      fsModule.writeFile = originalWriteFile;
      fsModule.mkdir = originalMkdir;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("plans inline and merged-file preparation without writes for the other providers", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-inline-preparation-")
    );
    try {
      const codex = new CodexCliProvider();
      const openCode = new OpenCodeCliProvider();
      const qwen = new QwenCliProvider();
      const antigravity = new AntigravityCliProvider();

      const preparations = [
        await codex.planMcpConfigArgs("/ext/mcp-server.js", workspaceRoot),
        await codex.planNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          undefined,
          []
        ),
        await openCode.planMcpConfigArgs("/ext/mcp-server.js", workspaceRoot),
        await openCode.planNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          [{ event: "stop", command: "node stop.js" }],
          []
        ),
        await qwen.planMcpConfigArgs("/ext/mcp-server.js", workspaceRoot),
        await qwen.planHeadlessUserHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          [{ event: "stop", command: "node stop.js" }],
          []
        ),
        await antigravity.planMcpConfigArgs(
          "/ext/mcp-server.js",
          workspaceRoot
        ),
        await antigravity.planNotificationHookArgs(
          "/ext",
          workspaceRoot,
          0,
          undefined,
          undefined,
          []
        ),
      ];

      assert.ok(preparations.every((preparation) => preparation.diagnostics));
      assert.strictEqual(
        preparations[2].mutations[0].path,
        undefined,
        "OpenCode inline config must remain process-local"
      );
      assert.strictEqual(
        preparations[3].mutations[0].path,
        undefined,
        "OpenCode hooks must remain process-local"
      );
      assert.strictEqual(
        preparations[0].mutations.length,
        0,
        "Codex MCP is inline"
      );
      assert.strictEqual(
        preparations[6].mutations[0].path,
        path.join(workspaceRoot, ".agents", "mcp_config.json")
      );
      assert.deepStrictEqual(await fs.readdir(workspaceRoot), []);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
