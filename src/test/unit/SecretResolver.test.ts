import * as assert from "assert";
import { suite, test } from "mocha";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import { createNoWorktreeExecutionWorkspace } from "../../platform/PlatformAdapter";
import type { SecretStore } from "../../platform/SecretStore";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import {
  userSecretKey,
  workspaceSecretKeyForRoot,
} from "../../platform/SecretKey";
import { EndConditionEvaluator } from "../../core/EndConditionEvaluator";
import {
  MissingSecretError,
  assertNoSecretInterpolationInPrompt,
  expandSecretInterpolations,
  getDeclaredSecretGrants,
  preflightWorkflowSecrets,
  resolveSecretEnvironment,
} from "../../utils/SecretResolver";

class InMemorySecretStore implements SecretStore {
  constructor(private readonly values: Record<string, string>) {}

  async get(key: string): Promise<string | undefined> {
    return this.values[key];
  }

  async store(key: string, value: string): Promise<void> {
    this.values[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete this.values[key];
  }

  async keys(): Promise<string[]> {
    return Object.keys(this.values);
  }
}

function platformWith(store: SecretStore): PlatformAdapter {
  return {
    getSecretStore: () => store,
    getWorkspaceRoot: () => "C:\\workspace",
    getWorkspaceRoots: () => ["C:\\workspace"],
    getNamedWorkspaceRoots: () => [],
    getExtensionPath: () => "C:\\extension",
  };
}

suite("SecretResolver", () => {
  test("prefers host environment and resolves managed workspace/user values", async () => {
    const store = new InMemorySecretStore({
      [workspaceSecretKeyForRoot("C:\\workspace", "WORKSPACE")]:
        "workspace-value",
      [userSecretKey("USER")]: "user-value",
    });

    const values = await resolveSecretEnvironment(
      ["HOST", "WORKSPACE", "USER"],
      {
        workspaceRoot: "C:\\workspace",
        secretStore: store,
        environment: { HOST: "host-value" },
      }
    );

    assert.deepStrictEqual(values, {
      HOST: "host-value",
      WORKSPACE: "workspace-value",
      USER: "user-value",
    });
  });

  test("rejects a missing managed or environment secret without exposing a value", async () => {
    await assert.rejects(
      resolveSecretEnvironment(["MISSING"], {
        workspaceRoot: "C:\\workspace",
        environment: {},
      }),
      (error: unknown) =>
        error instanceof MissingSecretError &&
        error.message.includes('Secret "MISSING"') &&
        error.message.includes("workspace/user or environment")
    );
  });

  test("expands only granted process-map references and rejects prompt interpolation", () => {
    assert.deepStrictEqual(
      expandSecretInterpolations(
        { TOKEN: "Bearer ${secret:API_TOKEN}" },
        { API_TOKEN: "resolved-value" },
        ["API_TOKEN"]
      ),
      { TOKEN: "Bearer resolved-value" }
    );

    assert.throws(
      () =>
        expandSecretInterpolations(
          { TOKEN: "${secret:API_TOKEN}" },
          { API_TOKEN: "resolved-value" },
          []
        ),
      /not granted/
    );
    assert.throws(
      () => assertNoSecretInterpolationInPrompt("Send ${secret:API_TOKEN}"),
      /not allowed in prompt text/
    );
  });

  test("preflight shares the resolution path and accepts env passthrough", async () => {
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "Use !HOST_TOKEN",
          mcpServers: [
            {
              id: "service",
              env: { TOKEN: "${secret:HOST_TOKEN}" },
            },
          ],
        },
      ],
    };

    const previousHostToken = process.env.HOST_TOKEN;
    process.env.HOST_TOKEN = "host-passthrough";
    try {
      await preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace"
      );
    } finally {
      if (previousHostToken === undefined) {
        delete process.env.HOST_TOKEN;
      } else {
        process.env.HOST_TOKEN = previousHostToken;
      }
    }
  });

  test("preflight reports the declaring step and missing name before spawn", async () => {
    const workflow: PromptFile = {
      steps: [{ name: "deploy", prompt: "Use !MISSING" }],
    };

    await assert.rejects(
      preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace"
      ),
      /Secret "MISSING" is missing for scope "deploy"/
    );
  });

  test("injects granted secrets into script environment without changing prompt text", async () => {
    const store = new InMemorySecretStore({
      [userSecretKey("SCRIPT_TOKEN")]: "script-value",
    });
    const platform = platformWith(store);
    const evaluator = new EndConditionEvaluator(
      platform,
      createNoWorktreeExecutionWorkspace(platform)
    );

    const result = await evaluator.evaluateCondition(
      {
        script: 'node -e "console.log(process.env.SCRIPT_TOKEN)"',
        returns: "script-value",
      },
      process.cwd(),
      undefined,
      undefined,
      ["SCRIPT_TOKEN"]
    );

    assert.strictEqual(result.passed, true, JSON.stringify(result));
  });

  suite("getDeclaredSecretGrants", () => {
    test("inherits the workflow array when the step declares nothing", () => {
      const workflow: PromptFile = {
        secrets: ["WORKFLOW_TOKEN"],
        steps: [{ prompt: "no inline reference" }],
      };

      assert.deepStrictEqual(
        getDeclaredSecretGrants(workflow.steps![0], workflow),
        ["WORKFLOW_TOKEN"]
      );
    });

    test("step-level null clears the inherited workflow grant", () => {
      const workflow: PromptFile = {
        secrets: ["WORKFLOW_TOKEN"],
        steps: [{ prompt: "no inline reference", secrets: null }],
      };

      assert.deepStrictEqual(
        getDeclaredSecretGrants(workflow.steps![0], workflow),
        []
      );
    });

    test("workflow-level null grants nothing", () => {
      const workflow: PromptFile = {
        secrets: null,
        steps: [{ prompt: "no inline reference" }],
      };

      assert.deepStrictEqual(
        getDeclaredSecretGrants(workflow.steps![0], workflow),
        []
      );
    });

    test("step array replaces the workflow array without merging", () => {
      const workflow: PromptFile = {
        secrets: ["WORKFLOW_TOKEN"],
        steps: [{ prompt: "no inline reference", secrets: ["STEP_TOKEN"] }],
      };

      assert.deepStrictEqual(
        getDeclaredSecretGrants(workflow.steps![0], workflow),
        ["STEP_TOKEN"]
      );
    });

    test("an inline reference still grants when the array is cleared", () => {
      const workflow: PromptFile = {
        secrets: ["WORKFLOW_TOKEN"],
        steps: [{ prompt: "use !INLINE_TOKEN here", secrets: null }],
      };

      assert.deepStrictEqual(
        getDeclaredSecretGrants(workflow.steps![0], workflow),
        ["INLINE_TOKEN"]
      );
    });
  });
});
