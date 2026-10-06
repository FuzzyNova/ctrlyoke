import { INTERACTIVE_TERMINAL_MODES } from "../../types/DashboardConstants";
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
  MissingSecretsError,
  UnapprovedSecretGrantsError,
  findSecretInterpolationsInPrompt,
  expandSecretInterpolations,
  assertSecretGrantTrust,
  getDeclaredSecretGrants,
  getWorkflowSecretGrants,
  preflightWorkflowSecrets as preflightWorkflowSecretsImpl,
  resolveSecretEnvironment,
} from "../../utils/SecretResolver";
import {
  SecretGrantsTrustStore,
  type SecretGrantTrustDecision,
} from "../../config/SecretGrantsTrustStore";

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
    interactiveTerminal: INTERACTIVE_TERMINAL_MODES.EMBEDDED_PTY,
    getWorkspaceRoot: () => "C:\\workspace",
    getWorkspaceRoots: () => ["C:\\workspace"],
    getNamedWorkspaceRoots: () => [],
    getExtensionPath: () => "C:\\extension",
  };
}

class AllowAllSecretGrantsTrustStore implements Pick<
  SecretGrantsTrustStore,
  "getDecision"
> {
  getDecision(
    _workspaceIdentity: string,
    _secretName: string
  ): SecretGrantTrustDecision {
    return "allow";
  }
}

type PreflightOptions = {
  failOnMissing?: boolean;
  trustStore?: Pick<SecretGrantsTrustStore, "getDecision">;
};

function preflightWorkflowSecrets(
  workflow: PromptFile,
  platform: PlatformAdapter,
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: PreflightOptions = {}
): Promise<string[]> {
  return preflightWorkflowSecretsImpl(
    workflow,
    platform,
    workspaceRoot,
    environment,
    {
      ...options,
      trustStore: options.trustStore ?? new AllowAllSecretGrantsTrustStore(),
    }
  );
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

  test("runtime trust gate allows user registry names and requires ALLOW otherwise", () => {
    const decisions = new Map<string, SecretGrantTrustDecision>();
    const trustStore = {
      getDecision: (_workspace: string, name: string) => decisions.get(name),
    };

    assertSecretGrantTrust(
      ["USER_MCP_TOKEN"],
      "C:\\workspace",
      ["USER_MCP_TOKEN"],
      trustStore
    );
    assert.throws(
      () =>
        assertSecretGrantTrust(
          ["WORKSPACE_MCP_TOKEN"],
          "C:\\workspace",
          [],
          trustStore
        ),
      /has not been approved for this workspace/u
    );

    decisions.set("WORKFLOW_TOKEN", "allow");
    assertSecretGrantTrust(["WORKFLOW_TOKEN"], "C:\\workspace", [], trustStore);
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
  });

  test("prompt-text secret interpolation is detected but never throws", () => {
    assert.deepStrictEqual(
      findSecretInterpolationsInPrompt(
        "Send ${secret:API_TOKEN} and ${secret:OTHER} and ${secret:API_TOKEN}"
      ),
      ["${secret:API_TOKEN}", "${secret:OTHER}"]
    );
    assert.deepStrictEqual(
      findSecretInterpolationsInPrompt("No interpolation here"),
      []
    );
  });

  test("preflight does not reject a prompt that merely quotes the interpolation syntax", async () => {
    // Plans and instruction files legitimately document this syntax; a run
    // whose prompt mentions it must not be blocked.
    const workflow: PromptFile = {
      prompt: "Explain why ${secret:X} is never substituted in prompt text",
      steps: [
        {
          name: "docs",
          prompt: "Document the ${secret:NAME} passthrough behavior",
        },
      ],
    };

    const missing = await preflightWorkflowSecrets(
      workflow,
      platformWith(new InMemorySecretStore({})),
      "C:\\workspace"
    );

    assert.deepStrictEqual(missing, []);
  });

  test("preflight ignores grants of steps that already completed", async () => {
    // A continued run re-runs preflight on every start. A step that finished
    // long ago (here one whose prompt quoted `!NAME` as an example) must not
    // keep warning about a secret it can never use again.
    const workflow: PromptFile = {
      steps: [
        {
          name: "finished",
          prompt: "Escape `!NAME` like other reference syntax",
          _runtime: { startedAt: 1, completedAt: 2 },
        },
        { name: "pending", prompt: "Use !PENDING_TOKEN" },
      ],
    };

    const missing = await preflightWorkflowSecrets(
      workflow,
      platformWith(new InMemorySecretStore({})),
      "C:\workspace",
      {},
      { failOnMissing: false }
    );

    assert.deepStrictEqual(missing, ["PENDING_TOKEN"]);
    assert.deepStrictEqual(getWorkflowSecretGrants(workflow), [
      "PENDING_TOKEN",
    ]);
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

  test("preflight reports missing names instead of throwing when configured not to fail", async () => {
    const workflow: PromptFile = {
      steps: [{ name: "deploy", prompt: "Use !MISSING" }],
    };

    const missing = await preflightWorkflowSecrets(
      workflow,
      platformWith(new InMemorySecretStore({})),
      "C:\\workspace",
      {},
      { failOnMissing: false }
    );

    assert.deepStrictEqual(missing, ["MISSING"]);
  });

  test("preflight remains strict when failOnMissing is explicitly true", async () => {
    const workflow: PromptFile = {
      steps: [{ name: "deploy", prompt: "Use !MISSING" }],
    };

    await assert.rejects(
      preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace",
        {},
        { failOnMissing: true }
      ),
      /Secret "MISSING" is missing for scope "deploy"/
    );
  });

  test("prompt interpolation never blocks preflight, in either mode", async () => {
    const workflow: PromptFile = {
      steps: [{ prompt: "Use ${secret:MISSING}" }],
    };

    // Prompt text is never a resolution boundary, so the token is passed
    // through verbatim and reported as an advisory by the executor instead.
    // It is not a granted secret, so it must not appear as a missing name.
    for (const failOnMissing of [false, true]) {
      const missing = await preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace",
        {},
        { failOnMissing }
      );
      assert.deepStrictEqual(missing, []);
    }
  });

  test("process-map references auto-grant without an explicit secrets array", async () => {
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "Run the service",
          mcpServers: [
            { id: "service", env: { TOKEN: "${secret:MAP_SECRET}" } },
          ],
        },
      ],
    };

    for (const failOnMissing of [false, true]) {
      const missing = await preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace",
        { MAP_SECRET: "resolved" },
        { failOnMissing }
      );
      assert.deepStrictEqual(missing, []);
    }
  });

  test("auto-grants process-map references on script, hook, condition, MCP env, and headers", async () => {
    const cases: Array<{
      secretName: string;
      workflow: PromptFile;
    }> = [
      {
        secretName: "SCRIPT_ENV_SECRET",
        workflow: {
          steps: [
            {
              type: "script",
              script: "echo script",
              env: { TOKEN: "${secret:SCRIPT_ENV_SECRET}" },
            },
          ],
        },
      },
      {
        secretName: "HOOK_ENV_SECRET",
        workflow: {
          steps: [
            {
              prompt: "Run the hook",
              hooks: [
                {
                  event: "stop",
                  command: "echo hook",
                  env: { TOKEN: "${secret:HOOK_ENV_SECRET}" },
                },
              ],
            },
          ],
        },
      },
      {
        secretName: "CONDITION_ENV_SECRET",
        workflow: {
          steps: [
            {
              prompt: "Run the condition",
              preCondition: {
                script: "echo condition",
                env: { TOKEN: "${secret:CONDITION_ENV_SECRET}" },
              },
            },
          ],
        },
      },
      {
        secretName: "MCP_ENV_SECRET",
        workflow: {
          steps: [
            {
              prompt: "Run MCP",
              mcpServers: [
                {
                  id: "service",
                  command: "echo service",
                  env: { TOKEN: "${secret:MCP_ENV_SECRET}" },
                },
              ],
            },
          ],
        },
      },
      {
        secretName: "MCP_HEADER_SECRET",
        workflow: {
          steps: [
            {
              prompt: "Run remote MCP",
              mcpServers: [
                {
                  id: "remote",
                  url: "https://example.test/mcp",
                  headers: {
                    Authorization: "Bearer ${secret:MCP_HEADER_SECRET}",
                  },
                },
              ],
            },
          ],
        },
      },
    ];

    for (const { secretName, workflow } of cases) {
      await preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace",
        { [secretName]: "resolved" }
      );
    }
  });

  test("workflow-level process maps grant at workflow scope", async () => {
    const workflow: PromptFile = {
      mcpServers: [
        {
          id: "workflow-service",
          command: "echo service",
          env: { TOKEN: "${secret:WORKFLOW_MAP_SECRET}" },
        },
      ],
      steps: [{ prompt: "Run the workflow service" }],
    };

    assert.deepStrictEqual(
      getDeclaredSecretGrants(workflow.steps![0], workflow),
      ["WORKFLOW_MAP_SECRET"]
    );
    await preflightWorkflowSecrets(
      workflow,
      platformWith(new InMemorySecretStore({})),
      "C:\\workspace",
      { WORKFLOW_MAP_SECRET: "resolved" }
    );
  });

  test("script steps do not inherit workflow hook or MCP secret grants", async () => {
    const workflow: PromptFile = {
      mcpServers: [
        {
          id: "workflow-service",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${secret:GITHUB_TOKEN}" },
        },
      ],
      hooks: [
        {
          event: "stop",
          command: "echo hook",
          env: { WEBHOOK: "${secret:SLACK_WEBHOOK}" },
        },
      ],
      steps: [{ type: "script", script: "echo script", secrets: null }],
    };

    assert.deepStrictEqual(
      getDeclaredSecretGrants(workflow.steps![0], workflow),
      []
    );
    assert.deepStrictEqual(getWorkflowSecretGrants(workflow), []);
    assert.deepStrictEqual(
      await preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace",
        {},
        { failOnMissing: false }
      ),
      []
    );
  });

  test("prompt steps still receive workflow hook and MCP secret grants", () => {
    const workflow: PromptFile = {
      mcpServers: [
        {
          id: "workflow-service",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer ${secret:GITHUB_TOKEN}" },
        },
      ],
      hooks: [
        {
          event: "stop",
          command: "echo hook",
          env: { WEBHOOK: "${secret:SLACK_WEBHOOK}" },
        },
      ],
      steps: [
        { type: "script", script: "echo script", secrets: null },
        { prompt: "Run the harness" },
      ],
    };

    assert.deepStrictEqual(
      getDeclaredSecretGrants(workflow.steps![0], workflow),
      []
    );
    assert.deepStrictEqual(
      getDeclaredSecretGrants(workflow.steps![1], workflow),
      ["GITHUB_TOKEN", "SLACK_WEBHOOK"]
    );
    assert.deepStrictEqual(getWorkflowSecretGrants(workflow), [
      "GITHUB_TOKEN",
      "SLACK_WEBHOOK",
    ]);
  });

  test("does not grant a step secret to an unrelated step", () => {
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "Step one",
          mcpServers: [
            {
              id: "step-one-service",
              command: "echo service",
              env: { TOKEN: "${secret:STEP_ONE_SECRET}" },
            },
          ],
        },
        { prompt: "Step two" },
      ],
    };

    assert.ok(
      getDeclaredSecretGrants(workflow.steps![0], workflow).includes(
        "STEP_ONE_SECRET"
      )
    );
    assert.ok(
      !getDeclaredSecretGrants(workflow.steps![1], workflow).includes(
        "STEP_ONE_SECRET"
      )
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
        compareSource: "stdout",
        expected: "script-value",
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

  test("unions workflow-wide grants across steps and finalStep in first-seen order", () => {
    const workflow: PromptFile = {
      secrets: ["WORKFLOW_TOKEN", "DUPLICATE_TOKEN"],
      steps: [
        {
          prompt: "Use !INLINE_TOKEN",
          secrets: ["STEP_TOKEN", "DUPLICATE_TOKEN"],
          mcpServers: [
            {
              id: "service",
              env: { TOKEN: "${secret:MAP_TOKEN}" },
            },
          ],
        },
        { prompt: "Inherit workflow grants" },
      ],
      finalStep: {
        prompt: "Use !FINAL_INLINE_TOKEN",
        secrets: ["FINAL_TOKEN", "DUPLICATE_TOKEN"],
        mcpServers: [
          {
            id: "final-service",
            env: { TOKEN: "${secret:FINAL_MAP_TOKEN}" },
          },
        ],
      },
    };

    assert.deepStrictEqual(getWorkflowSecretGrants(workflow), [
      "INLINE_TOKEN",
      "STEP_TOKEN",
      "DUPLICATE_TOKEN",
      "MAP_TOKEN",
      "WORKFLOW_TOKEN",
      "FINAL_INLINE_TOKEN",
      "FINAL_TOKEN",
      "FINAL_MAP_TOKEN",
    ]);
  });

  suite("secret grant trust checks", () => {
    const workflow: PromptFile = {
      steps: [{ name: "deploy", prompt: "Use !TRUSTED_TOKEN" }],
    };

    test("blocks pending grants even when failOnMissing is false", async () => {
      const trustStore: Pick<SecretGrantsTrustStore, "getDecision"> = {
        getDecision: () => undefined,
      };

      await assert.rejects(
        preflightWorkflowSecrets(
          workflow,
          platformWith(new InMemorySecretStore({})),
          "C:\\workspace",
          { TRUSTED_TOKEN: "resolved" },
          { failOnMissing: false, trustStore }
        ),
        (error: unknown) =>
          error instanceof UnapprovedSecretGrantsError &&
          /Secret grant "TRUSTED_TOKEN" has not been approved/.test(
            error.message
          )
      );
    });

    test("allows an approved grant", async () => {
      const trustStore = new AllowAllSecretGrantsTrustStore();
      const missing = await preflightWorkflowSecrets(
        workflow,
        platformWith(new InMemorySecretStore({})),
        "C:\\workspace",
        { TRUSTED_TOKEN: "resolved" },
        { trustStore }
      );

      assert.deepStrictEqual(missing, []);
    });

    test("blocks a denied grant", async () => {
      const trustStore: Pick<SecretGrantsTrustStore, "getDecision"> = {
        getDecision: () => "deny",
      };

      await assert.rejects(
        preflightWorkflowSecrets(
          workflow,
          platformWith(new InMemorySecretStore({})),
          "C:\\workspace",
          { TRUSTED_TOKEN: "resolved" },
          { trustStore }
        ),
        /Secret grant "TRUSTED_TOKEN" has not been approved/
      );
    });

    test("distinguishes an unapproved grant from a genuinely unresolvable one in the error text", async () => {
      const unapprovedTrustStore: Pick<SecretGrantsTrustStore, "getDecision"> =
        { getDecision: () => undefined };

      await assert.rejects(
        preflightWorkflowSecrets(
          workflow,
          platformWith(new InMemorySecretStore({})),
          "C:\\workspace",
          { TRUSTED_TOKEN: "resolved" },
          { trustStore: unapprovedTrustStore }
        ),
        /has not been approved for this workspace.*ctrlyoke trust-secret-grants/
      );

      const allowAllTrustStore = new AllowAllSecretGrantsTrustStore();
      await assert.rejects(
        preflightWorkflowSecrets(
          workflow,
          platformWith(new InMemorySecretStore({})),
          "C:\\workspace",
          {},
          { trustStore: allowAllTrustStore }
        ),
        (error: unknown) =>
          error instanceof MissingSecretsError &&
          /Secret "TRUSTED_TOKEN" is missing for scope "deploy"/.test(
            error.message
          ) &&
          !/has not been approved/.test(error.message)
      );
    });
  });
});
