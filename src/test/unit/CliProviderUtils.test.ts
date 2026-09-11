import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { CodexCliProvider } from "../../core/harness/codex/CodexCliProvider";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { CliMcpConfigGenerator } from "../../core/harness/shared/CliMcpConfigGenerator";
import {
  CliProviderUtils,
  RetryableAsyncCache,
} from "../../core/harness/shared/CliProviderUtils";
import { canonicalizeDriveLetter } from "../../utils/PathCasing";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

function parseInlineTomlEnv(toml: string): Record<string, string> {
  const envStart = toml.indexOf("env=");
  assert.ok(envStart >= 0, "TOML entry should contain an env table");

  const tableStart = toml.indexOf("{", envStart);
  assert.ok(tableStart >= 0, "TOML env should start with an inline table");

  let depth = 0;
  let tableEnd = -1;
  let inString = false;
  for (let index = tableStart; index < toml.length; index += 1) {
    const character = toml[index];
    if (character === "'") {
      if (inString && toml[index + 1] === "'") {
        index += 1;
      } else {
        inString = !inString;
      }
    } else if (!inString && character === "{") {
      depth += 1;
    } else if (!inString && character === "}") {
      depth -= 1;
      if (depth === 0) {
        tableEnd = index;
        break;
      }
    }
  }
  assert.ok(tableEnd > tableStart, "TOML env should close its inline table");

  const entries: Record<string, string> = {};
  const inner = toml.slice(tableStart + 1, tableEnd);
  for (const pair of inner.split(",")) {
    const separator = pair.indexOf("=");
    assert.ok(separator > 0, "TOML env entries should contain an equals sign");
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    assert.ok(
      value.startsWith("'") && value.endsWith("'"),
      "TOML env values should be quoted strings"
    );
    entries[key] = value.slice(1, -1).replace(/''/g, "'");
  }
  return entries;
}

suite("CliProviderUtils", () => {
  setup(() => {
    configService.setCliOverlay({});
  });

  teardown(() => {
    configService.setCliOverlay({});
    configService.setUserBackend({ getAll: () => ({}), set: async () => {} });
  });

  test("includes every workspace-folder root exactly once for --add-dir", () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const secondaryRoot = path.join(
      os.tmpdir(),
      "ctrlyoke-workspace-secondary"
    );

    const result = CliProviderUtils.getWorkspaceDirs(primaryRoot, [
      primaryRoot,
      secondaryRoot,
      secondaryRoot,
    ]);

    assert.deepStrictEqual(result, [
      path.resolve(primaryRoot),
      path.resolve(secondaryRoot),
    ]);
  });

  test("appends every effective approved external root after workspace roots", () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const externalRoot = path.join(os.tmpdir(), "ctrlyoke-external-root");
    // User-scope allowedExternalFileRoots is trusted immediately (no
    // trust-store decision needed) — read via getScoped(..., "user"), which
    // only sees the user/workspace backends, not the CLI overlay.
    configService.setUserBackend({
      getAll: () => ({
        permissions: { allowedExternalFileRoots: [externalRoot] },
      }),
      set: async () => {},
    });

    const result = CliProviderUtils.getWorkspaceDirs(primaryRoot, []);

    assert.deepStrictEqual(result, [
      path.resolve(primaryRoot),
      path.resolve(externalRoot),
    ]);
  });

  test("canonicalizes a lowercase drive letter for --add-dir on Windows", function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const root = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const lowerRoot = root.charAt(0).toLowerCase() + root.slice(1);
    const expected = canonicalizeDriveLetter(path.resolve(root));

    const result = CliProviderUtils.getWorkspaceDirs(lowerRoot, []);

    assert.deepStrictEqual(result, [expected]);
  });

  test("dedups a directory regardless of drive-letter casing", function () {
    if (process.platform !== "win32") {
      this.skip();
      return;
    }
    const root = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const lowerRoot = root.charAt(0).toLowerCase() + root.slice(1);
    const expected = canonicalizeDriveLetter(path.resolve(root));

    const result = CliProviderUtils.getWorkspaceDirs(root, [lowerRoot]);

    assert.deepStrictEqual(result, [expected]);
  });

  test("uses the workflow replacement set for --add-dir roots", async () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const inheritedRoot = path.join(os.tmpdir(), "ctrlyoke-inherited-root");
    const workflowRoot = path.join(os.tmpdir(), "ctrlyoke-workflow-root");
    const workflowFile = path.join(primaryRoot, "workflow.ctrlyoke.json");
    const original = ConfigurationUtils.getEffectiveApprovedExternalFileRoots;
    let receivedWorkflow:
      | { identity: string; declaredRoots: string[] | null | undefined }
      | undefined;

    ConfigurationUtils.getEffectiveApprovedExternalFileRoots = (
      _workspaceIdentity,
      workflow
    ) => {
      receivedWorkflow = workflow;
      return workflow?.declaredRoots === null
        ? []
        : (workflow?.declaredRoots ?? [inheritedRoot]);
    };

    try {
      const workflowContext = {
        filePath: workflowFile,
        stateRoot: primaryRoot,
        workflowFile: { trustedExternalRoots: [workflowRoot] },
      };
      const result = CliProviderUtils.getWorkspaceDirs(
        primaryRoot,
        [],
        [inheritedRoot],
        workflowContext
      );

      assert.deepStrictEqual(result, [
        path.resolve(primaryRoot),
        path.resolve(workflowRoot),
      ]);
      assert.strictEqual(receivedWorkflow?.declaredRoots?.[0], workflowRoot);

      for (const provider of [
        new ClaudeCliProvider(),
        new CodexCliProvider(),
        new CopilotCliProvider(),
        new AntigravityCliProvider(),
      ]) {
        const args = await provider.buildCliArgs(
          { prompt: "prompt" },
          false,
          "extension",
          primaryRoot,
          undefined,
          {
            promptIndex: 0,
            allPrompts: [],
            ...workflowContext,
          },
          []
        );
        const addDirValues = args.flatMap((arg, index) =>
          arg === "--add-dir" ? [args[index + 1]] : []
        );
        assert.ok(addDirValues.includes(path.resolve(workflowRoot)));
        assert.ok(!addDirValues.includes(path.resolve(inheritedRoot)));
      }

      const disabled = CliProviderUtils.getWorkspaceDirs(
        primaryRoot,
        [],
        [inheritedRoot],
        {
          filePath: workflowFile,
          stateRoot: primaryRoot,
          workflowFile: { trustedExternalRoots: null },
        }
      );
      assert.deepStrictEqual(disabled, [path.resolve(primaryRoot)]);
    } finally {
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots = original;
    }
  });

  test("shares successful probes and retries a failed probe", async () => {
    const cache = new RetryableAsyncCache<string>();
    let calls = 0;

    const result = await Promise.all([
      cache.getOrRun("test --version", async () => {
        calls += 1;
        return "1.0.0";
      }),
      cache.getOrRun("test --version", async () => {
        calls += 1;
        return "1.0.0";
      }),
    ]);

    assert.deepStrictEqual(result, ["1.0.0", "1.0.0"]);
    assert.strictEqual(calls, 1);

    await assert.rejects(
      cache.getOrRun("missing --version", async () => {
        calls += 1;
        throw new Error("not installed");
      }),
      /not installed/u
    );
    const retryResult = await cache.getOrRun("missing --version", async () => {
      calls += 1;
      return "1.0.0";
    });

    assert.strictEqual(retryResult, "1.0.0");
    assert.strictEqual(calls, 3);
  });

  test("runs and caches help output while retrying failed help commands", async () => {
    const [firstResult, coalescedResult] = await Promise.all([
      CliProviderUtils.runHelpCommand("node --help"),
      CliProviderUtils.runHelpCommand("node --help"),
    ]);

    assert.match(firstResult, /Usage: node/u);
    assert.strictEqual(coalescedResult, firstResult);

    const missingCommand = `ctrlyoke-missing-help-${Date.now()} --help`;
    await assert.rejects(
      CliProviderUtils.runHelpCommand(missingCommand),
      /not found|cannot find|ENOENT|resolve/u
    );
    await assert.rejects(
      CliProviderUtils.runHelpCommand(missingCommand),
      /not found|cannot find|ENOENT|resolve/u
    );
  });

  test("keeps provider-specific references in settings MCP env and headers", () => {
    const entries = CliProviderUtils.buildSettingsJsonMcpEntries(
      undefined,
      "/workspace",
      undefined,
      undefined,
      [
        {
          id: "api",
          command: "node",
          env: { API_TOKEN: "${secret:API_TOKEN}" },
        },
        {
          id: "remote",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${secret:API_TOKEN}" },
        },
      ],
      undefined,
      undefined,
      CliProviderUtils.createMcpSecretConfigOptions((name) => `{env:${name}}`)
    );

    assert.strictEqual(
      (entries.api as { env: Record<string, string> }).env.API_TOKEN,
      "{env:API_TOKEN}"
    );
    assert.strictEqual(
      (entries.remote as { headers: Record<string, string> }).headers
        .Authorization,
      "Bearer {env:API_TOKEN}"
    );
  });

  test("emits the same ctrlyoke env through JSON, TOML, and settings JSON", () => {
    const serverPath = String.raw`C:\extension\out\mcp-server.js`;
    const workspaceRoot = String.raw`C:\workspace\execution`;
    const stateRoot = String.raw`C:\workspace\state`;
    const workingFilePath = String.raw`C:\workspace\state\workflow.json`;
    const additionalEnv = {
      CTRLYOKE_MAX_QUEUE_SIZE: "25",
      CTRLYOKE_CUSTOM_FLAG: "enabled",
    };

    const jsonEntry = (
      JSON.parse(
        CliMcpConfigGenerator.generateJsonConfig(
          serverPath,
          workspaceRoot,
          undefined,
          workingFilePath,
          additionalEnv,
          stateRoot
        )
      ) as { mcpServers: { ctrlyoke: { env: Record<string, string> } } }
    ).mcpServers.ctrlyoke;
    const tomlEnv = parseInlineTomlEnv(
      CliMcpConfigGenerator.generateInlineTomlConfig(
        "ctrlyoke",
        serverPath,
        workspaceRoot,
        workingFilePath,
        additionalEnv,
        stateRoot
      )
    );
    const settingsEntry = CliProviderUtils.buildSettingsJsonMcpEntries(
      serverPath,
      workspaceRoot,
      workingFilePath,
      additionalEnv,
      undefined,
      undefined,
      stateRoot
    ).ctrlyoke as { env: Record<string, string> };

    assert.deepStrictEqual(settingsEntry.env, jsonEntry.env);
    assert.deepStrictEqual(tomlEnv, jsonEntry.env);
  });

  test("creates a restrictive substitution strategy for non-expanding providers", () => {
    const options = CliProviderUtils.createMcpSecretConfigOptions(undefined, {
      API_TOKEN: "secret-value",
    });
    assert.deepStrictEqual(options, {
      mode: "substitute",
      resolvedValues: { API_TOKEN: "secret-value" },
      restrictivePermissions: true,
    });
  });
});
