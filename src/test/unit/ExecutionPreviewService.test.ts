import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, teardown, test } from "mocha";
import {
  ExecutionPreviewService,
  defaultCommandDisplayShell,
  type ExecutionPreviewHarness,
} from "../../core/ExecutionPreviewService";
import { renderCommandForDisplay } from "../../types/CommandDisplayFormatter";
import { CliPromptPreparer } from "../../core/harness/shared/CliPromptPreparer";
import { ExecutionPlanBuilder } from "../../core/harness/shared/ExecutionPlanBuilder";
import { ClaudeCliProvider } from "../../core/harness/claude/ClaudeCliProvider";
import { HARNESS_IDS, PREVIEW_SCOPES } from "../../types/DashboardConstants";
import type { HarnessCapabilityRegistrySnapshot } from "../../types/CompatibilityTypes";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import type { ExecutionPropertyDefaults } from "../../types/ExecutionPropertyResolver";

const fsPromises = fs.promises;
let temporaryRoots: string[] = [];

function createDefaults(): ExecutionPropertyDefaults {
  return {
    harness: HARNESS_IDS.CLAUDE_CLI,
    modelsByHarness: { [HARNESS_IDS.CLAUDE_CLI]: "default-model" },
    additionalArgsByHarness: {},
    executionMode: "headless",
    resumeSession: false,
    mcpServers: [],
    hooks: null,
  };
}

function createCapabilities(): HarnessCapabilityRegistrySnapshot {
  const provider = new ClaudeCliProvider();
  const permissions = provider.toolPermissionMapper.capabilities;
  const state = {
    fidelity: "exact" as const,
    mechanism: "native" as const,
    verification: "verified" as const,
  };
  return {
    schemaVersion: 1,
    enabledDomains: ["permissions"],
    harnesses: {
      [HARNESS_IDS.CLAUDE_CLI]: {
        available: true,
        version: "1.0.0",
        descriptor: { harnessId: HARNESS_IDS.CLAUDE_CLI, permissions },
        effective: {
          permissions: {
            mode: state,
            allowedTools: state,
            deniedTools: state,
          },
        },
      },
    },
  } as HarnessCapabilityRegistrySnapshot;
}

function createPromptPreparer(): CliPromptPreparer {
  return new CliPromptPreparer({
    shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
    buildPromptSections: async (prompt) => ({
      skillContent: null,
      agentContent: null,
      directFileRefs: [],
      excerptContent: null,
      userPromptText: prompt.prompt,
    }),
    extractLeadingSlashCommand: () => null,
    isSimplePrompt: () => true,
    buildPriorContextXmlFromItems: () => "",
    getWorkspaceRoot: () => undefined,
    getTempFileSplitConfig: () => undefined,
    formatDirectFileRef: (value) => value,
    formatTempFileRef: (_manager, value) => value,
    formatCategorizedReferences: (
      _agents,
      _skills,
      _files,
      _context,
      _excerpts,
      prompts
    ) => prompts.join(" "),
  });
}

function createHarness(workspaceRoot?: string): ExecutionPreviewHarness {
  const provider = new ClaudeCliProvider();
  return {
    provider,
    promptPreparer: createPromptPreparer(),
    executionPlanBuilder: new ExecutionPlanBuilder({
      provider,
      getWorkspaceRoot: () => workspaceRoot,
      getWorkspaceRoots: () => (workspaceRoot ? [workspaceRoot] : []),
      getExtensionPath: () => "extension",
      getExecutionMode: () => "headless",
      getEnabledHookNotificationEvents: () => [],
      resolveCliCommand: async (command, args) => ({
        command,
        args: [...args],
        displayCommand: [command, ...args].join(" "),
        launcherKind: "direct",
      }),
    }),
  };
}

function createService(workspaceRoot?: string): ExecutionPreviewService {
  const harness = createHarness(workspaceRoot);
  return new ExecutionPreviewService({
    defaults: createDefaults(),
    capabilities: createCapabilities(),
    getHarness: () => harness,
    workspaceRoot,
    workspaceRoots: workspaceRoot ? [workspaceRoot] : [],
    extensionPath: "extension",
    hostCanProvidePty: false,
    platform: "linux",
  });
}

suite("ExecutionPreviewService", () => {
  teardown(async () => {
    for (const root of temporaryRoots.splice(0)) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });

  test("uses shared planning paths and produces a step-scoped DTO", async () => {
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "workflow-model",
      steps: [
        {
          name: "Inspect",
          prompt: "inspect {{target}}",
          toolPermissions: {
            mode: "custom",
            allowedTools: ["read"],
          },
        },
        { prompt: "not selected" },
      ],
      vars: { target: "src/app.ts" },
    };

    const preview = await createService().build({
      workflow,
      scope: { kind: PREVIEW_SCOPES.STEP, stepIndex: 0 },
      workflowName: "inspection",
    });

    assert.strictEqual(preview.steps.length, 1);
    assert.strictEqual(preview.steps[0].stepName, "Inspect");
    assert.strictEqual(
      preview.steps[0].resolvedProperties.model,
      "workflow-model"
    );
    assert.strictEqual(
      preview.steps[0].resolvedProperties.propertySources.model,
      "workflow"
    );
    assert.ok(preview.steps[0].command);
    assert.ok(preview.steps[0].command?.args.includes("inspect src/app.ts"));
    assert.ok(preview.steps[0].command?.args.includes("--model"));
    assert.ok(
      preview.steps[0].prompt?.sections.some((section) =>
        section.body?.includes("src/app.ts")
      )
    );
  });

  test("omits MCP environment values while retaining structural key names", async () => {
    const root = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-preview-")
    );
    temporaryRoots.push(root);
    const secret = "preview-very-secret-token-value";
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "use the service",
          mcpServers: [
            {
              id: "private-service",
              command: "node",
              env: { PRIVATE_API_KEY: secret },
            },
          ],
        },
      ],
    };

    const writes: string[] = [];
    const originalWriteFile = fsPromises.writeFile;
    fsPromises.writeFile = (async (...args) => {
      writes.push(String(args[0]));
      return originalWriteFile(...args);
    }) as typeof fsPromises.writeFile;
    try {
      const preview = await createService(root).build({ workflow });
      const serialized = JSON.stringify(preview);
      assert.ok(serialized.includes("PRIVATE_API_KEY"));
      assert.ok(!serialized.includes(secret));
      assert.deepStrictEqual(
        preview.steps[0].mcpApplication?.servers[0].environmentKeys,
        ["PRIVATE_API_KEY"]
      );
      assert.deepStrictEqual(writes, []);
    } finally {
      fsPromises.writeFile = originalWriteFile;
    }
  });

  test("defaults Windows command display to PowerShell and POSIX to sh-style quoting", () => {
    assert.strictEqual(defaultCommandDisplayShell("win32"), "powershell");
    assert.strictEqual(defaultCommandDisplayShell("linux"), "posix");

    const windows = renderCommandForDisplay(
      "node",
      ["a path/file.ts", "x&y"],
      defaultCommandDisplayShell("win32")
    );
    assert.ok(windows.includes("'a path/file.ts'"));
    assert.ok(windows.includes("'x&y'"));

    const cmd = renderCommandForDisplay(
      "node",
      ["a path/file.ts", "x&y"],
      "cmd"
    );
    assert.ok(cmd.includes("^&"));
    assert.ok(cmd.includes("a^ path/file.ts"));

    const posix = renderCommandForDisplay(
      "/usr/bin/node",
      ["a path/file.ts", "it's ready"],
      defaultCommandDisplayShell("linux")
    );
    assert.ok(posix.includes("'a path/file.ts'"));
    assert.ok(posix.includes(`'it'"'"'s ready'`));
  });

  test("does not execute conditions or resolve external session state", async () => {
    let conditionExecuted = false;
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "safe preview",
          preCondition: {
            script: 'node -e "condition"',
            onPass: "continue",
          },
          endCondition: {
            script: 'node -e "condition"',
            returns: "ok",
          },
        },
      ],
    };
    const preview = await createService().build({ workflow });
    conditionExecuted = preview.steps[0].conditions.pre[0].configured;
    assert.strictEqual(conditionExecuted, true);
    assert.strictEqual(preview.steps[0].conditions.end[0].configured, true);
    assert.ok(preview.steps[0].conditions.pre[0].scriptPath);
  });
});
