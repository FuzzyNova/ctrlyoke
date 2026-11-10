import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { parse } from "smol-toml";
import { configService } from "../../config/CtrlYokeConfigService";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";
import { AntigravityHarnessAdapter } from "../../core/harness/antigravity/AntigravityHarnessAdapter";
import { ClaudeHarnessAdapter } from "../../core/harness/claude/ClaudeHarnessAdapter";
import { CodexHarnessAdapter } from "../../core/harness/codex/CodexHarnessAdapter";
import { CopilotHarnessAdapter } from "../../core/harness/copilot/CopilotHarnessAdapter";
import { CliMcpConfigGenerator } from "../../core/harness/shared/CliMcpConfigGenerator";
import { HarnessAdapterUtils } from "../../core/harness/shared/HarnessAdapterUtils";
import { canonicalizeDriveLetter } from "../../utils/PathCasing";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

function parseInlineTomlEnv(toml: string): Record<string, string> {
  const parsed = parse(toml) as {
    mcp_servers: { ctrlyoke: { env: Record<string, string> } };
  };
  return { ...parsed.mcp_servers.ctrlyoke.env };
}

suite("HarnessAdapterUtils", () => {
  setup(() => {
    configService.setCliOverlay({});
  });

  teardown(() => {
    configService.setCliOverlay({});
    configService.setUserBackend({
      getAll: () => ({}),
      set: async () => ({}),
    });
  });

  test("includes every workspace-folder root exactly once for --add-dir", () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const secondaryRoot = path.join(
      os.tmpdir(),
      "ctrlyoke-workspace-secondary"
    );

    const result = HarnessAdapterUtils.getWorkspaceDirs(primaryRoot, [
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
    // User-scope trustedExternalRoots is trusted immediately (no
    // trust-store decision needed) — read via getScoped(..., "user"), which
    // only sees the user/workspace backends, not the CLI overlay.
    configService.setUserBackend({
      getAll: () => ({
        permissions: { trustedExternalRoots: [externalRoot] },
      }),
      set: async () => ({}),
    });

    const result = HarnessAdapterUtils.getWorkspaceDirs(primaryRoot, []);

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

    const result = HarnessAdapterUtils.getWorkspaceDirs(lowerRoot, []);

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

    const result = HarnessAdapterUtils.getWorkspaceDirs(root, [lowerRoot]);

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
      const result = HarnessAdapterUtils.getWorkspaceDirs(
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
        new ClaudeHarnessAdapter(),
        new CodexHarnessAdapter(),
        new CopilotHarnessAdapter(),
        new AntigravityHarnessAdapter(),
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

      const disabled = HarnessAdapterUtils.getWorkspaceDirs(
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

  test("keys workflow trust by the authored file, not the run's working copy", () => {
    const primaryRoot = path.join(os.tmpdir(), "ctrlyoke-workspace-primary");
    const authoredFile = path.join(primaryRoot, "workflow.ctrlyoke.yaml");
    const runWorkingCopy = path.join(
      os.tmpdir(),
      "ctrlyoke-state",
      ".runs",
      "workflow",
      "run-20261105",
      "workflow.ctrlyoke.json"
    );
    const workflowFile = { trustedExternalRoots: ["/shared"] };

    const duringRun = HarnessAdapterUtils.getWorkflowExternalRootsContext(
      primaryRoot,
      {
        filePath: runWorkingCopy,
        sourceDefinitionPath: authoredFile,
        stateRoot: primaryRoot,
        workflowFile,
      }
    );
    const asApproved = ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
      primaryRoot,
      authoredFile
    );
    assert.strictEqual(duringRun?.identity, asApproved);

    // No authored file (a workflow loaded only from its working copy).
    const workingCopyOnly = HarnessAdapterUtils.getWorkflowExternalRootsContext(
      primaryRoot,
      { filePath: runWorkingCopy, stateRoot: primaryRoot, workflowFile }
    );
    assert.strictEqual(
      workingCopyOnly?.identity,
      ExternalRootsTrustStore.canonicalizeWorkflowIdentity(
        primaryRoot,
        runWorkingCopy
      )
    );
  });

  test("runs and caches help output while retrying failed help commands", async () => {
    const [firstResult, coalescedResult] = await Promise.all([
      HarnessAdapterUtils.runHelpCommand("node --help"),
      HarnessAdapterUtils.runHelpCommand("node --help"),
    ]);

    assert.match(firstResult, /Usage: node/u);
    assert.strictEqual(coalescedResult, firstResult);

    const missingCommand = `ctrlyoke-missing-help-${Date.now()} --help`;
    await assert.rejects(
      HarnessAdapterUtils.runHelpCommand(missingCommand),
      /not found|cannot find|ENOENT|resolve/u
    );
    await assert.rejects(
      HarnessAdapterUtils.runHelpCommand(missingCommand),
      /not found|cannot find|ENOENT|resolve/u
    );
  });

  test("keeps provider-specific references in settings MCP env and headers", () => {
    const entries = HarnessAdapterUtils.buildSettingsJsonMcpEntries(
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
      HarnessAdapterUtils.createMcpSecretConfigOptions(
        (name) => `{env:${name}}`
      )
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
      CTRLYOKE_MAX_STEPS: "25",
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
    const settingsEntry = HarnessAdapterUtils.buildSettingsJsonMcpEntries(
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
    const options = HarnessAdapterUtils.createMcpSecretConfigOptions(
      undefined,
      {
        API_TOKEN: "secret-value",
      }
    );
    assert.deepStrictEqual(options, {
      mode: "substitute",
      resolvedValues: { API_TOKEN: "secret-value" },
      restrictivePermissions: true,
    });
  });
});
