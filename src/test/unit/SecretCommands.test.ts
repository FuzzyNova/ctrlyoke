import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import { configService } from "../../config/CtrlYokeConfigService";
import { secretGrantsTrustStore } from "../../config/SecretGrantsTrustStore";
import { suite, test } from "mocha";
import type { PlatformAdapter } from "../../platform/PlatformAdapter";
import type { SecretStore } from "../../platform/SecretStore";
import {
  userSecretKey,
  workspaceSecretKeyForRoot,
} from "../../platform/SecretKey";
import { SETTING_SCOPES } from "../../types/DashboardConstants";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import {
  checkSecretsCommand,
  listSecretsCommand,
  removeSecretCommand,
  setSecretCommand,
  type SecretCommandDependencies,
  type SecretCommandIo,
} from "../../cli/SecretCommands";
import {
  registerSecretCommands,
  type SecretCheckOptions,
  type SecretListOptions,
  type SecretRemoveOptions,
  type SecretSetOptions,
} from "../../cli/SecretCommandDefinitions";

class InMemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

class TestPlatform implements PlatformAdapter {
  constructor(private readonly store: SecretStore) {}

  getSecretStore(): SecretStore {
    return this.store;
  }

  getWorkspaceRoot(): string {
    return "/workspace";
  }

  getWorkspaceRoots(): string[] {
    return ["/workspace"];
  }

  getNamedWorkspaceRoots(): [] {
    return [];
  }

  getExtensionPath(): string {
    return "/extension";
  }
}

class TestIo implements SecretCommandIo {
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly hiddenPrompts: string[] = [];
  isInteractive = false;
  confirmed = false;
  stdinValue = "";
  hiddenValue = "";

  writeOut(message: string): void {
    this.output.push(message);
  }

  writeErr(message: string): void {
    this.errors.push(message);
  }

  confirm(): Promise<boolean> {
    return Promise.resolve(this.confirmed);
  }

  readHidden(prompt: string): Promise<string> {
    this.hiddenPrompts.push(prompt);
    return Promise.resolve(this.hiddenValue);
  }

  readStdin(): Promise<string> {
    return Promise.resolve(this.stdinValue);
  }
}

function dependencies(
  store: SecretStore,
  workspaceRoot = "/workspace",
  environment: NodeJS.ProcessEnv = {}
): SecretCommandDependencies {
  return {
    workspaceRoot,
    secretStore: store,
    platform: new TestPlatform(store),
    environment,
  };
}

function createParserProgram(calls: {
  set?: { name: string; options: SecretSetOptions };
  list?: SecretListOptions;
  remove?: { name: string; options: SecretRemoveOptions };
  check?: { file: string | undefined; options: SecretCheckOptions };
}): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  registerSecretCommands(program, {
    set: async (name, options) => {
      calls.set = { name, options };
    },
    list: async (options) => {
      calls.list = options;
    },
    remove: async (name, options) => {
      calls.remove = { name, options };
    },
    check: async (file, options) => {
      calls.check = { file, options };
    },
  });
  return program;
}

function workflowDependencies(
  store: SecretStore,
  workflow: PromptFile,
  environment: NodeJS.ProcessEnv = {}
): SecretCommandDependencies {
  return {
    ...dependencies(store, "/workspace", environment),
    parseWorkflow: async () => workflow,
  };
}

suite("Secret command parser", () => {
  test("parses scopes and stdin without exposing a value-bearing argv option", async () => {
    const calls: Parameters<typeof createParserProgram>[0] = {};
    await createParserProgram(calls).parseAsync(
      ["secret", "set", "API_TOKEN", "--scope", "workspace", "--stdin"],
      { from: "user" }
    );

    assert.strictEqual(calls.set?.name, "API_TOKEN");
    assert.strictEqual(calls.set?.options.scope, "workspace");
    assert.strictEqual(calls.set?.options.stdin, true);

    await assert.rejects(
      createParserProgram({}).parseAsync(
        ["secret", "set", "API_TOKEN", "--value", "must-not-parse"],
        { from: "user" }
      ),
      /unknown option '--value'/
    );
  });

  test("has no secret get command", async () => {
    await assert.rejects(
      createParserProgram({}).parseAsync(["secret", "get", "API_TOKEN"], {
        from: "user",
      }),
      /unknown command 'get'/
    );
  });

  test("parses rm confirmation bypass and optional check file", async () => {
    const removeCalls: Parameters<typeof createParserProgram>[0] = {};
    await createParserProgram(removeCalls).parseAsync(
      ["secret", "rm", "API_TOKEN", "--scope", "workspace", "-y"],
      { from: "user" }
    );
    assert.strictEqual(removeCalls.remove?.name, "API_TOKEN");
    assert.strictEqual(removeCalls.remove?.options.scope, "workspace");
    assert.strictEqual(removeCalls.remove?.options.yes, true);

    const checkCalls: Parameters<typeof createParserProgram>[0] = {};
    await createParserProgram(checkCalls).parseAsync(["secret", "check"], {
      from: "user",
    });
    assert.strictEqual(checkCalls.check?.file, undefined);
  });
});

suite("Secret command handlers", () => {
  test("reads set values from stdin and stores them in the requested scope", async () => {
    const store = new InMemorySecretStore();
    const io = new TestIo();
    io.stdinValue = "stdin-secret\n";

    await setSecretCommand(
      "API_TOKEN",
      { stdin: true, scope: SETTING_SCOPES.WORKSPACE },
      dependencies(store),
      io
    );

    assert.strictEqual(
      await store.get(workspaceSecretKeyForRoot("/workspace", "API_TOKEN")),
      "stdin-secret\n"
    );
    assert.deepStrictEqual(io.hiddenPrompts, []);
    assert.deepStrictEqual(io.output, [
      "Stored secret API_TOKEN in workspace scope.",
    ]);
  });

  test("confirms rm unless bypassed with -y", async () => {
    const store = new InMemorySecretStore();
    await store.store(userSecretKey("API_TOKEN"), "secret-value");
    const io = new TestIo();
    io.isInteractive = true;
    io.confirmed = false;

    await removeSecretCommand("API_TOKEN", {}, dependencies(store), io);
    assert.strictEqual(
      await store.get(userSecretKey("API_TOKEN")),
      "secret-value"
    );

    await removeSecretCommand(
      "API_TOKEN",
      { yes: true },
      dependencies(store),
      io
    );
    assert.strictEqual(await store.get(userSecretKey("API_TOKEN")), undefined);
  });

  test("lists safe metadata and never prints managed values", async () => {
    const store = new InMemorySecretStore();
    await store.store(userSecretKey("MANAGED_TOKEN"), "value-must-not-print");
    const io = new TestIo();
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-secret-test-")
    );
    try {
      await listSecretsCommand(
        {},
        dependencies(store, tempRoot, { ENV_TOKEN: "environment-value" }),
        io
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }

    const output = io.output.join("\n");
    assert.match(
      output,
      /MANAGED_TOKEN\s+scope=user\s+state=set\s+source=managed/
    );
    assert.doesNotMatch(output, /value-must-not-print|environment-value/);
  });

  test("returns success for resolvable workflows and non-zero for missing names with scope", async () => {
    const resolvableIo = new TestIo();
    const originalGetDecision = secretGrantsTrustStore.getDecision;
    secretGrantsTrustStore.getDecision = (_workspaceIdentity, name) =>
      name === "CI_TOKEN"
        ? "allow"
        : originalGetDecision.call(
            secretGrantsTrustStore,
            _workspaceIdentity,
            name
          );
    let resolvable: number;
    try {
      resolvable = await checkSecretsCommand(
        "workflow.ctrlyoke.yaml",
        {},
        workflowDependencies(
          new InMemorySecretStore(),
          { steps: [{ name: "deploy", prompt: "Use !CI_TOKEN" }] },
          { CI_TOKEN: "from-ci" }
        ),
        resolvableIo
      );
    } finally {
      secretGrantsTrustStore.getDecision = originalGetDecision;
    }
    assert.strictEqual(resolvable, 0);
    assert.deepStrictEqual(resolvableIo.errors, []);

    const missingIo = new TestIo();
    const missing = await checkSecretsCommand(
      "workflow.ctrlyoke.yaml",
      {},
      workflowDependencies(new InMemorySecretStore(), {
        steps: [
          {
            name: "deploy",
            prompt: "Use !MISSING_TOKEN and !SECOND_MISSING_TOKEN",
          },
        ],
      }),
      missingIo
    );
    assert.strictEqual(missing, 1);
    assert.match(
      missingIo.errors.join("\n"),
      /MISSING_TOKEN.*scope.*workspace\/user or environment.*SECOND_MISSING_TOKEN/
    );
  });

  test("secret check stays strict when context resolution mode is warn", async () => {
    configService.setCliOverlay({
      execution: { strictContextResolution: "warn" },
    });
    try {
      const io = new TestIo();
      const result = await checkSecretsCommand(
        "workflow.ctrlyoke.yaml",
        {},
        workflowDependencies(new InMemorySecretStore(), {
          steps: [{ name: "deploy", prompt: "Use !MISSING_TOKEN" }],
        }),
        io
      );

      assert.strictEqual(result, 1);
      assert.match(io.errors.join("\n"), /MISSING_TOKEN/);
    } finally {
      configService.setCliOverlay({});
    }
  });
});
