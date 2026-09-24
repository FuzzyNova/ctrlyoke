import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import {
  resolveOpenCodePermissionCollisionContext,
  type OpenCodePermissionCollisionContext,
} from "../../core/harness/opencode/OpenCodeInlineConfig";
import { OpenCodeLogParser } from "../../core/harness/opencode/OpenCodeLogParser";
import { CliResponseCollector } from "../../core/harness/shared/CliResponseCollector";
import { Log } from "../../utils/Log";
import {
  RunSecretRedactor,
  secretRedactionService,
} from "../../utils/SecretRedactionService";
import { PERMISSION_MODES } from "../../types/DashboardConstants";

suite("OpenCodeCliProvider", () => {
  function collisionContext(
    topLevelKeys: string[],
    nestedKeysByTool: Record<string, string[]> = {}
  ): OpenCodePermissionCollisionContext {
    return {
      topLevelKeys: new Set(topLevelKeys),
      nestedKeysByTool: new Map(
        Object.entries(nestedKeysByTool).map(([tool, keys]) => [
          tool,
          new Set(keys),
        ])
      ),
    };
  }

  test("builds the inline config shape for every permission mode", () => {
    const provider = new OpenCodeCliProvider();
    const extensionPath = path.join(os.tmpdir(), "opencode-inline-extension");
    const pluginPath = path.resolve(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );

    for (const mode of Object.values(PERMISSION_MODES)) {
      const config = provider.buildInlineConfig({
        extensionPath,
        toolPermissions: {
          mode,
          allowedTools: ["write"],
          deniedTools: ["shell(rm:*)"],
        },
      });

      assert.deepStrictEqual(config.plugin, [pluginPath]);
      if (
        mode === PERMISSION_MODES.NONE ||
        mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
      ) {
        assert.strictEqual("permission" in config, false);
      } else if (mode === PERMISSION_MODES.ALLOW_ALL) {
        assert.deepStrictEqual(config.permission, {
          "*": "allow",
          bash: { "rm *": "deny" },
        });
      } else {
        assert.deepStrictEqual(config.permission, {
          "*": "ask",
          read: "allow",
          glob: "allow",
          grep: "allow",
          lsp: "allow",
          edit: "allow",
          bash: { "rm *": "deny" },
        });
      }
    }
  });

  test("rewrites colliding top-level and nested keys until they are novel", () => {
    const provider = new OpenCodeCliProvider();
    const config = provider.buildInlineConfig({
      extensionPath: "extension",
      permissionCollisionContext: collisionContext(
        ["*", "bash", "bash*", "bash**"],
        { bash: ["foo *", "foo **"] }
      ),
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["shell(foo:*)"],
        deniedTools: [],
      },
    });

    assert.deepStrictEqual(config.permission, {
      "**": "ask",
      read: "allow",
      glob: "allow",
      grep: "allow",
      lsp: "allow",
      "bash***": { "foo ***": "allow" },
    });
  });

  test("avoids scalar/object type mismatches by rewriting the tool key", () => {
    const provider = new OpenCodeCliProvider();
    const config = provider.buildInlineConfig({
      extensionPath: "extension",
      permissionCollisionContext: collisionContext(["*", "bash"]),
      toolPermissions: {
        mode: PERMISSION_MODES.ALLOW_ALL,
        allowedTools: [],
        deniedTools: ["shell"],
      },
    });

    assert.strictEqual(config.permission?.bash, undefined);
    assert.strictEqual(config.permission?.["bash*"], "deny");
  });

  test("skips a rule and emits a diagnostic when collision rewriting is exhausted", () => {
    const takenKeys = Array.from({ length: 1001 }, (_, index) =>
      "*".repeat(index + 1)
    );
    const provider = new OpenCodeCliProvider();
    const config = provider.buildInlineConfig({
      extensionPath: "extension",
      permissionCollisionContext: collisionContext(takenKeys),
      toolPermissions: {
        mode: PERMISSION_MODES.ALLOW_ALL,
        allowedTools: [],
        deniedTools: [],
      },
    });

    assert.deepStrictEqual(config.permission, {});
  });

  test("does not pass OpenCode substitution tokens through permission or MCP values", () => {
    const provider = new OpenCodeCliProvider();
    const config = provider.buildInlineConfig({
      extensionPath: "extension",
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["shell(echo {env:SECRET} *)"],
        deniedTools: [],
      },
      userServers: [
        {
          id: "unsafe",
          url: "https://example.test/{file:secret.txt}",
          headers: { Authorization: "Bearer {env:TOKEN}" },
        },
        {
          id: "safe",
          command: "node",
          args: ["server.js"],
          env: { SAFE: "value" },
        },
      ],
    });

    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes("{env:"));
    assert.ok(!serialized.includes("{file:"));
    assert.deepStrictEqual(config.mcp?.safe, {
      type: "local",
      command: ["node", "server.js"],
      environment: { SAFE: "value" },
    });
    assert.strictEqual(config.mcp?.unsafe, undefined);
  });

  test("refuses to expose an oversized inline config", async () => {
    const provider = new OpenCodeCliProvider();
    await provider.prepareToolPermissions(
      {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [],
        deniedTools: Array.from(
          { length: 2500 },
          (_, index) => `shell(command-${index}:*)`
        ),
      },
      { workspaceRoot: "workspace" }
    );

    assert.throws(
      () => provider.getHeadlessSpawnEnv(),
      /exceeds the 32768-byte defensive limit/
    );
  });

  test("resolves project permission keys before preparing inline permissions", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-inline-collision-")
    );
    const provider = new OpenCodeCliProvider();
    try {
      await fs.writeFile(
        path.join(workspaceRoot, "opencode.json"),
        JSON.stringify({ permission: { bash: { "foo *": "allow" } } }),
        "utf8"
      );
      await provider.buildCliArgs(
        { prompt: "test" },
        false,
        path.join(workspaceRoot, "extension"),
        workspaceRoot,
        undefined,
        { promptIndex: 0, allPrompts: [] }
      );
      await provider.prepareToolPermissions(
        {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: [],
          deniedTools: ["shell(foo:*)"],
        },
        { workspaceRoot }
      );

      const config = JSON.parse(
        provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!
      );
      assert.deepStrictEqual(config.permission, {
        "*": "ask",
        read: "allow",
        glob: "allow",
        grep: "allow",
        lsp: "allow",
        "bash*": { "foo **": "deny" },
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("resolves the OPENCODE_CONFIG file alongside global and project layers", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-inline-config-layers-")
    );
    const configuredPath = path.join(workspaceRoot, "configured.json");
    const previousConfiguredPath = process.env.OPENCODE_CONFIG;
    try {
      await fs.writeFile(
        configuredPath,
        JSON.stringify({
          permission: {
            "config-layer-tool": { "from config": "allow" },
          },
        }),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspaceRoot, "opencode.json"),
        JSON.stringify({
          permission: {
            "config-layer-tool": { "from project": "deny" },
          },
        }),
        "utf8"
      );
      process.env.OPENCODE_CONFIG = configuredPath;

      const context =
        await resolveOpenCodePermissionCollisionContext(workspaceRoot);
      assert.ok(context.topLevelKeys.has("config-layer-tool"));
      assert.deepStrictEqual(
        [...context.nestedKeysByTool.get("config-layer-tool")!].sort(),
        ["from config", "from project"]
      );
    } finally {
      if (previousConfiguredPath === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = previousConfiguredPath;
      }
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("builds MCP entries for inline delivery without writing a workspace file", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-inline-mcp-")
    );
    const extensionPath = path.join(workspaceRoot, "extension");
    const mcpServerPath = path.join(extensionPath, "mcp-server.js");
    const workingFilePath = path.join(workspaceRoot, "workflow.ctrlyoke.yaml");
    const additionalEnv = { CTRLYOKE_TEST: "true" };
    const userServers = [
      {
        id: "local-server",
        command: "node",
        args: ["local-server.js"],
        env: { LOCAL_TOKEN: "token" },
      },
      {
        id: "remote-server",
        url: "https://mcp.example.test/server",
        headers: { Authorization: "Bearer token" },
      },
    ];
    const provider = new OpenCodeCliProvider();
    try {
      const inlineConfig = provider.buildInlineConfig({
        extensionPath,
        mcpServerPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv,
        userServers,
      });

      const mcpArgs = await provider.getMcpConfigArgs(
        mcpServerPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv,
        userServers
      );

      assert.deepStrictEqual(mcpArgs, []);
      assert.deepStrictEqual(
        JSON.parse(provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!),
        { mcp: inlineConfig.mcp, plugin: [] }
      );
      assert.deepStrictEqual(await fs.readdir(workspaceRoot), []);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("redacts echoed inline config and MCP credentials from stderr", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-redact-")
    );
    const extensionPath = path.join(workspaceRoot, "extension");
    try {
      const provider = new OpenCodeCliProvider();
      await provider.getMcpConfigArgs(
        undefined,
        workspaceRoot,
        undefined,
        undefined,
        [
          {
            id: "local-server",
            command: "node",
            args: ["server.js"],
            env: { API_KEY: "sk-super-secret-value" },
          },
          {
            id: "remote-server",
            url: "https://mcp.example.test/server",
            headers: { Authorization: "Bearer remote-secret" },
          },
        ]
      );
      const configContent =
        provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!;

      const redactor = new RunSecretRedactor();
      const release = secretRedactionService.register(redactor);
      redactor.addResolvedValues({
        API_KEY: "sk-super-secret-value",
        AUTHORIZATION: "Bearer remote-secret",
      });
      const redacted = secretRedactionService.redactText(
        `JSONC parse error in OPENCODE_CONFIG_CONTENT\n${configContent}\n` +
          `env leak: sk-super-secret-value / Bearer remote-secret`
      );
      release();

      assert.ok(!redacted.includes("sk-super-secret-value"));
      assert.ok(!redacted.includes("Bearer remote-secret"));
      assert.ok(!redacted.includes(configContent));
      // The surrounding diagnostic must survive — suppressing all stderr would
      // leave every ordinary OpenCode failure undiagnosable.
      assert.ok(redacted.includes("JSONC parse error"));
      assert.ok(redacted.includes("env leak:"));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      assert.ok(extensionPath);
    }
  });

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

  test("passes user hooks through env and leaves both spawn workspaces unchanged", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-provider-")
    );
    const extensionPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-extension-")
    );
    const pluginSourcePath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );
    const hooks = [
      { event: "stop", command: "node ./stop-hook.js" },
      { event: "permissionRequest", command: "node ./permission-hook.js" },
      { event: "notification", command: "node ./notification-hook.js" },
    ];

    try {
      await fs.mkdir(path.dirname(pluginSourcePath), { recursive: true });
      await fs.writeFile(pluginSourcePath, "export default {};\n", "utf8");

      for (const isInteractive of [false, true]) {
        const provider = new OpenCodeCliProvider();
        await provider.buildCliArgs(
          { prompt: "test" },
          isInteractive,
          extensionPath,
          workspaceRoot,
          undefined,
          {
            promptIndex: 0,
            allPrompts: [],
            resolvedProperties: { hooks },
          } as any
        );

        const expectedHooks = JSON.stringify(hooks.slice(0, 2));
        const env = isInteractive
          ? provider.getInteractiveSpawnEnv()
          : provider.getHeadlessSpawnEnv();
        assert.strictEqual(env.CTRLYOKE_OPENCODE_HOOKS, expectedHooks);
        assert.strictEqual(
          JSON.parse(env.OPENCODE_CONFIG_CONTENT!).plugin[0],
          path.resolve(pluginSourcePath)
        );
      }

      assert.deepStrictEqual(await fs.readdir(workspaceRoot), []);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(extensionPath, { recursive: true, force: true });
    }
  });

  test("keeps the completion plugin when notification is the only unsupported user hook", async () => {
    const provider = new OpenCodeCliProvider();
    const extensionPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-notification-extension-")
    );
    const pluginSourcePath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );

    try {
      await fs.mkdir(path.dirname(pluginSourcePath), { recursive: true });
      await fs.writeFile(pluginSourcePath, "export default {};\n", "utf8");
      await provider.buildCliArgs(
        { prompt: "test" },
        false,
        extensionPath,
        undefined,
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: {
            hooks: [{ event: "notification", command: "node notify.js" }],
          },
        } as any
      );

      const env = provider.getHeadlessSpawnEnv();
      assert.strictEqual(env.CTRLYOKE_OPENCODE_HOOKS, undefined);
      assert.deepStrictEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!), {
        plugin: [path.resolve(pluginSourcePath)],
      });
    } finally {
      await fs.rm(extensionPath, { recursive: true, force: true });
    }
  });

  test("warns and deploys the minimal workspace fallback when the external plugin fails to load", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-fallback-workspace-")
    );
    const extensionPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-fallback-extension-")
    );
    const sourcePath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-opencode-plugin.ts"
    );
    const provider = new OpenCodeCliProvider();
    const warnings: string[] = [];
    const originalWarn = Log.warn;

    try {
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, "export default {};\n", "utf8");
      Log.warn = (message: string) => warnings.push(message);
      Object.defineProperty(provider, "pluginPathIsReadable", {
        value: async () => {
          throw new Error("simulated plugin-load failure");
        },
      });

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
            hooks: [{ event: "stop", command: "echo fallback" }],
          },
        } as any
      );

      assert.ok(
        warnings.some((warning) =>
          warning.includes("falling back to .opencode/plugin")
        )
      );
      assert.deepStrictEqual(
        JSON.parse(
          await fs.readFile(
            path.join(
              workspaceRoot,
              ".opencode",
              "plugin",
              "ctrlyoke-hooks.json"
            ),
            "utf8"
          )
        ),
        [{ event: "stop", command: "echo fallback" }]
      );
      assert.deepStrictEqual(
        JSON.parse(provider.getInteractiveSpawnEnv().OPENCODE_CONFIG_CONTENT!),
        { plugin: [] }
      );

      await provider.cleanupWorkspaceArtifacts(workspaceRoot);
      await assert.rejects(
        fs.access(
          path.join(
            workspaceRoot,
            ".opencode",
            "plugin",
            "ctrlyoke-completion-hook.ts"
          )
        ),
        /ENOENT/
      );
    } finally {
      Log.warn = originalWarn;
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.rm(extensionPath, { recursive: true, force: true });
    }
  });

  test("delivers the same inline config to headless and interactive spawns", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-inline-env-")
    );
    const extensionPath = path.join(workspaceRoot, "extension");
    const workingFilePath = path.join(workspaceRoot, "workflow.ctrlyoke.yaml");
    const workflowContext = {
      promptIndex: 0,
      allPrompts: [],
      workingFilePath,
      resolvedProperties: {
        mcpServers: [
          { id: "temporary", command: "node", args: ["temporary.js"] },
        ],
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["write", "shell(git:*)"],
          deniedTools: ["shell(rm:*)"],
        },
      },
    } as any;

    try {
      const headlessProvider = new OpenCodeCliProvider();
      await headlessProvider.buildCliArgs(
        { prompt: "headless" },
        false,
        extensionPath,
        workspaceRoot,
        undefined,
        workflowContext
      );
      await headlessProvider.prepareToolPermissions(
        workflowContext.resolvedProperties.toolPermissions,
        { workspaceRoot, workingFilePath }
      );

      const interactiveProvider = new OpenCodeCliProvider();
      await interactiveProvider.buildCliArgs(
        { prompt: "interactive" },
        true,
        extensionPath,
        workspaceRoot,
        undefined,
        workflowContext
      );
      await interactiveProvider.prepareToolPermissions(
        workflowContext.resolvedProperties.toolPermissions,
        { workspaceRoot, workingFilePath }
      );

      assert.strictEqual(
        headlessProvider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT,
        interactiveProvider.getInteractiveSpawnEnv().OPENCODE_CONFIG_CONTENT
      );
      const config = JSON.parse(
        headlessProvider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!
      );
      assert.deepStrictEqual(config.permission, {
        "*": "ask",
        read: "allow",
        glob: "allow",
        grep: "allow",
        lsp: "allow",
        edit: "allow",
        bash: { "git *": "allow", "rm *": "deny" },
      });
      assert.deepStrictEqual(config.mcp.temporary, {
        type: "local",
        command: ["node", "temporary.js"],
      });
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("resets inline config between consecutive steps", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-inline-reset-")
    );
    const provider = new OpenCodeCliProvider();
    const extensionPath = path.join(workspaceRoot, "extension");
    const firstContext = {
      promptIndex: 0,
      allPrompts: [],
      resolvedProperties: {
        mcpServers: [{ id: "first", command: "node", args: ["first.js"] }],
      },
    } as any;

    try {
      await provider.buildCliArgs(
        { prompt: "first" },
        false,
        extensionPath,
        workspaceRoot,
        undefined,
        firstContext
      );
      await provider.prepareToolPermissions(
        {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["write"],
          deniedTools: [],
        },
        { workspaceRoot }
      );
      const firstConfig = JSON.parse(
        provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!
      );
      assert.ok(firstConfig.mcp.first);
      assert.ok(firstConfig.permission);

      await provider.buildCliArgs(
        { prompt: "second" },
        false,
        extensionPath,
        undefined,
        undefined,
        {
          promptIndex: 1,
          allPrompts: [],
          resolvedProperties: { mcpServers: [] },
        } as any
      );
      const secondConfig = JSON.parse(
        provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!
      );
      assert.strictEqual("mcp" in secondConfig, false);
      assert.strictEqual("permission" in secondConfig, false);
      assert.deepStrictEqual(secondConfig.plugin, firstConfig.plugin);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not create opencode.json or other inline config files in the workspace", async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "opencode-inline-files-")
    );
    const provider = new OpenCodeCliProvider();

    try {
      await provider.buildCliArgs(
        { prompt: "file-free" },
        false,
        path.join(workspaceRoot, "extension"),
        workspaceRoot,
        undefined,
        {
          promptIndex: 0,
          allPrompts: [],
          resolvedProperties: {
            mcpServers: [
              { id: "temporary", command: "node", args: ["server.js"] },
            ],
          },
        } as any
      );
      await provider.prepareToolPermissions(
        {
          mode: PERMISSION_MODES.ALLOW_ALL,
          allowedTools: [],
          deniedTools: ["write"],
        },
        { workspaceRoot }
      );

      assert.deepStrictEqual(await fs.readdir(workspaceRoot), []);
      assert.ok(
        JSON.parse(provider.getHeadlessSpawnEnv().OPENCODE_CONFIG_CONTENT!).mcp
      );
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
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

  test("builds native file arguments for resolved image attachments", () => {
    const provider = new OpenCodeCliProvider();
    assert.deepStrictEqual(
      provider.buildImageAttachmentArgs(["shots/one.png", "shots/two.jpg"]),
      ["--file", "shots/one.png", "--file", "shots/two.jpg"]
    );
  });
});
