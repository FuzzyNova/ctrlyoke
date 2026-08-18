import * as assert from "assert";
import { suite, test } from "mocha";
import {
  SECRET_REGISTRY_STATES,
  SETTING_SCOPES,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import type { SecretStore } from "../../platform/SecretStore";
import {
  userSecretKey,
  userSecretMetadataKey,
  workspaceSecretKeyForRoot,
} from "../../platform/SecretKey";
import {
  SecretRegistryService,
  type SecretRegistryMcpReference,
  type SecretRegistryWorkflowReference,
} from "../../ui/SecretRegistryService";
import { WebviewMessageRouter } from "../../ui/WebviewMessageRouter";

class InMemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  storeCalls = 0;

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.storeCalls += 1;
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Thenable<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

function serviceFor(
  store: InMemorySecretStore,
  environment: NodeJS.ProcessEnv,
  workflows: SecretRegistryWorkflowReference[] = [],
  mcpServers: SecretRegistryMcpReference[] = []
): SecretRegistryService {
  return new SecretRegistryService({
    secretStore: store,
    getWorkspaceRoot: () => "/workspace",
    environment,
    now: () => 1_700_000_000_000,
    getWorkflowReferences: async () => workflows,
    getMcpReferences: async () => mcpServers,
  });
}

suite("SecretRegistryService", () => {
  test("classifies managed, detected, and missing names without returning values", async () => {
    const store = new InMemorySecretStore();
    await store.store(userSecretKey("MANAGED_TOKEN"), "super-secret");
    await store.store(
      userSecretMetadataKey("MANAGED_TOKEN"),
      JSON.stringify({ description: "Deploy token", lastUpdated: 42 })
    );
    const service = serviceFor(
      store,
      { DETECTED_TOKEN: "from-env" },
      [{ workflow: "deploy.ctrlyoke.yaml", secretNames: ["MISSING_TOKEN"] }],
      [{ server: "deploy-api", secretNames: ["DETECTED_TOKEN"] }]
    );

    const entries = await service.list(SETTING_SCOPES.USER);
    assert.deepStrictEqual(
      entries.map((entry) => [entry.name, entry.state]),
      [
        [
          "DETECTED_TOKEN",
          SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED,
        ],
        ["MANAGED_TOKEN", SECRET_REGISTRY_STATES.MANAGED_AND_SET],
        [
          "MISSING_TOKEN",
          SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND,
        ],
      ]
    );
    const managed = entries.find((entry) => entry.name === "MANAGED_TOKEN");
    assert.deepStrictEqual(managed, {
      name: "MANAGED_TOKEN",
      scope: SETTING_SCOPES.USER,
      state: SECRET_REGISTRY_STATES.MANAGED_AND_SET,
      description: "Deploy token",
      lastUpdated: 42,
      usedBy: { mcpServers: [], workflows: [] },
    });
    assert.ok(!JSON.stringify(entries).includes("super-secret"));
  });

  test("uses the requested scope for managed values and usage", async () => {
    const store = new InMemorySecretStore();
    const workspaceRoot = "/workspace";
    await store.store(
      workspaceSecretKeyForRoot(workspaceRoot, "SHARED_TOKEN"),
      "workspace-secret"
    );
    const service = serviceFor(
      store,
      {},
      [{ workflow: "build.ctrlyoke.json", secretNames: ["SHARED_TOKEN"] }],
      [{ server: "build-server", secretNames: ["SHARED_TOKEN"] }]
    );

    const userEntries = await service.list(SETTING_SCOPES.USER);
    assert.strictEqual(
      userEntries.find((entry) => entry.name === "SHARED_TOKEN")?.state,
      SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND
    );
    const workspaceEntries = await service.list(SETTING_SCOPES.WORKSPACE);
    assert.strictEqual(
      workspaceEntries.find((entry) => entry.name === "SHARED_TOKEN")?.state,
      SECRET_REGISTRY_STATES.MANAGED_AND_SET
    );
    assert.deepStrictEqual(
      await service.getUsedBy("SHARED_TOKEN", SETTING_SCOPES.WORKSPACE),
      {
        mcpServers: ["build-server"],
        workflows: ["build.ctrlyoke.json"],
      }
    );
  });

  test("validates names before writing any value", async () => {
    const store = new InMemorySecretStore();
    const service = serviceFor(store, {});

    await assert.rejects(
      service.set("not-valid", SETTING_SCOPES.USER, "secret-value"),
      /Invalid secret name/
    );
    assert.strictEqual(store.storeCalls, 0);
    await assert.rejects(
      service.delete("not-valid", SETTING_SCOPES.USER),
      /Invalid secret name/
    );
  });

  test("the set response contains no secret value", async () => {
    const store = new InMemorySecretStore();
    const service = serviceFor(store, {});
    const messages: unknown[] = [];
    const router = new WebviewMessageRouter(
      (message: unknown) => messages.push(message),
      { sendWorkflowPropertiesToSettings: async () => {} } as any,
      {} as any,
      () => undefined,
      {} as any,
      { handleClearWorkflow: async () => {}, updateWorkflowName: () => {} },
      service
    );

    await router.route({
      type: MESSAGE_TYPES.SET_SECRET,
      name: "API_TOKEN",
      scope: SETTING_SCOPES.USER,
      value: "secret-value-that-must-not-escape",
      description: "API token",
    });

    assert.deepStrictEqual(messages, [
      {
        type: MESSAGE_TYPES.SECRET_SET,
        name: "API_TOKEN",
        scope: SETTING_SCOPES.USER,
        state: "set",
      },
    ]);
    assert.ok(
      !JSON.stringify(messages).includes("secret-value-that-must-not-escape")
    );
  });
});
