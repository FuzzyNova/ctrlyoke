import * as assert from "assert";
import { suite, test } from "mocha";
import { HarnessCapabilityRegistry } from "../../core/HarnessCapabilityRegistry";
import type { HarnessCapabilitySource } from "../../core/HarnessCapabilityRegistry";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { AntigravityToolPermissionMapper } from "../../core/harness/antigravity/AntigravityToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../core/harness/claude/ClaudeToolPermissionMapper";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { CopilotToolPermissionMapper } from "../../core/harness/copilot/CopilotToolPermissionMapper";
import { OpenCodeToolPermissionMapper } from "../../core/harness/opencode/OpenCodeToolPermissionMapper";
import { QwenToolPermissionMapper } from "../../core/harness/qwen/QwenToolPermissionMapper";
import type {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionApplication,
  ToolPermissionConfig,
} from "../../core/harness/shared/interfaces/IToolPermissionMapper";
import type { HarnessConfig } from "../../core/harness/shared/interfaces/ICliProvider";
import {
  CAPABILITY_DOMAINS,
  HARNESS_IDS,
  HOOK_EVENT_ORDER,
  type HarnessId,
} from "../../types/DashboardConstants";
import type {
  CapabilityDeclaration,
  HarnessCapabilityFacts,
  PermissionCapabilityDescriptor,
} from "../../types/CompatibilityTypes";

const HARNESS_ID_LIST = Object.values(HARNESS_IDS) as HarnessId[];
type CapabilityProvider = HarnessCapabilitySource["provider"];

class DescriptorMapper implements IToolPermissionMapper {
  constructor(readonly capabilities: PermissionCapabilityDescriptor) {}

  async prepare(
    _config: ToolPermissionConfig,
    _context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    return { cliArgs: [], diagnostics: [] };
  }

  hasFullPermissions(): boolean {
    return false;
  }
}

class StubProvider implements CapabilityProvider {
  readonly config: HarnessConfig;
  readonly toolPermissionMapper: IToolPermissionMapper;
  private readonly versionReader: () => string | undefined;
  private available: boolean;

  constructor(
    harnessId: HarnessId,
    mapper: IToolPermissionMapper,
    version: string | undefined,
    available = true,
    readonly capabilityFacts: HarnessCapabilityFacts = {
      permissions: mapper.capabilities,
    }
  ) {
    this.config = {
      name: harnessId,
      harnessId,
      displayName: harnessId,
      terminalName: harnessId,
      installHint: "",
      shouldStreamHeadlessOutput: false,
    };
    this.toolPermissionMapper = mapper;
    this.versionReader = () => version;
    this.available = available;
  }

  async checkAvailability(): Promise<boolean> {
    return this.available;
  }

  async getVersion(): Promise<string | undefined> {
    return this.versionReader();
  }

  get capabilities() {
    return this.capabilityFacts;
  }
}

function mapperFor(harnessId: HarnessId): IToolPermissionMapper {
  switch (harnessId) {
    case HARNESS_IDS.COPILOT_CLI:
      return new CopilotToolPermissionMapper();
    case HARNESS_IDS.CLAUDE_CLI:
      return new ClaudeToolPermissionMapper();
    case HARNESS_IDS.CODEX_CLI:
      return new CodexToolPermissionMapper();
    case HARNESS_IDS.OPENCODE_CLI:
      return new OpenCodeToolPermissionMapper();
    case HARNESS_IDS.QWEN_CLI:
      return new QwenToolPermissionMapper();
    case HARNESS_IDS.ANTIGRAVITY_CLI:
      return new AntigravityToolPermissionMapper();
    default:
      throw new Error(`Unknown harness ${harnessId}`);
  }
}

function makeRegistry(
  versionByHarness: Partial<Record<HarnessId, string | undefined>> = {},
  descriptorOverrides: Partial<
    Record<HarnessId, PermissionCapabilityDescriptor>
  > = {},
  capabilityOverrides: Partial<Record<HarnessId, HarnessCapabilityFacts>> = {},
  enabledDomains: readonly (typeof CAPABILITY_DOMAINS)[keyof typeof CAPABILITY_DOMAINS][] = [
    CAPABILITY_DOMAINS.PERMISSIONS,
  ]
): HarnessCapabilityRegistry {
  return new HarnessCapabilityRegistry({
    enabledDomains,
    sourceFactory: (harnessId) => {
      const mapper = mapperFor(harnessId);
      const effectiveMapper = descriptorOverrides[harnessId]
        ? new DescriptorMapper(descriptorOverrides[harnessId]!)
        : mapper;
      const version = Object.prototype.hasOwnProperty.call(
        versionByHarness,
        harnessId
      )
        ? versionByHarness[harnessId]
        : "1.0.0";
      return {
        provider: new StubProvider(
          harnessId,
          effectiveMapper,
          version,
          true,
          capabilityOverrides[harnessId] ?? {
            permissions: effectiveMapper.capabilities,
          }
        ),
      };
    },
  });
}

function declaration(
  fidelity: CapabilityDeclaration["fidelity"],
  mechanism: CapabilityDeclaration["mechanism"]
): CapabilityDeclaration {
  return {
    fidelity,
    mechanism,
    verification: {
      kind: "manual",
      reference: "registry-test",
      basis: "cli-version",
      verifiedVersions: ["*"],
    },
  };
}

function allDomainFacts(harnessId: HarnessId): HarnessCapabilityFacts {
  return {
    permissions: mapperFor(harnessId).capabilities,
    promptInputs: { images: declaration("exact", "native") },
    hooks: Object.fromEntries(
      HOOK_EVENT_ORDER.map((event) => [
        event,
        declaration("partial", "translated-cli"),
      ])
    ),
    mcp: { perServerToolFiltering: declaration("exact", "workspace-config") },
  };
}

function allHarnessDomainFacts(): Partial<
  Record<HarnessId, HarnessCapabilityFacts>
> {
  return Object.fromEntries(
    HARNESS_ID_LIST.map((harnessId) => [harnessId, allDomainFacts(harnessId)])
  ) as Partial<Record<HarnessId, HarnessCapabilityFacts>>;
}

suite("HarnessCapabilityRegistry", () => {
  test("registry descriptors reference each mapper capability object", async () => {
    const registry = makeRegistry();
    for (const harnessId of HARNESS_ID_LIST) {
      const installed = await registry.getInstalledCapabilities(harnessId);
      assert.strictEqual(
        installed.descriptor.permissions,
        mapperFor(harnessId).capabilities
      );
    }
  });

  test("enables prompt-input compatibility for every registered harness", async function () {
    this.timeout(10_000);
    const registry = new HarnessCapabilityRegistry();
    const snapshot = await registry.getSnapshot();
    assert.deepStrictEqual(snapshot.enabledDomains, [
      CAPABILITY_DOMAINS.PERMISSIONS,
      CAPABILITY_DOMAINS.PROMPT_INPUTS,
      CAPABILITY_DOMAINS.HOOKS,
      CAPABILITY_DOMAINS.MCP,
    ]);
  });

  test("requires all three permission leaves for every HarnessId", async () => {
    const snapshot = await makeRegistry().getSnapshot();

    assert.deepStrictEqual(
      Object.keys(snapshot.harnesses).sort(),
      [...HARNESS_ID_LIST].sort()
    );
    for (const harnessId of HARNESS_ID_LIST) {
      const permissions = snapshot.harnesses[harnessId].descriptor.permissions;
      assert.ok(permissions);
      assert.deepStrictEqual(Object.keys(permissions).sort(), [
        "allowedTools",
        "deniedTools",
        "mode",
      ]);
    }
  });

  test("derives verified and unknown states, including missing version", async () => {
    const verified = await makeRegistry({
      [HARNESS_IDS.QWEN_CLI]: "0.20.1",
    }).getInstalledCapabilities(HARNESS_IDS.QWEN_CLI);
    assert.strictEqual(
      verified.effective?.permissions?.allowedTools.verification,
      "verified"
    );

    const missingVersion = await makeRegistry({
      [HARNESS_IDS.QWEN_CLI]: undefined,
    }).getInstalledCapabilities(HARNESS_IDS.QWEN_CLI);
    assert.strictEqual(missingVersion.version, undefined);
    assert.strictEqual(
      missingVersion.effective?.permissions?.allowedTools.verification,
      "unknown"
    );
  });

  test("resolves each capability independently for the installed version", async () => {
    const base = mapperFor(HARNESS_IDS.QWEN_CLI).capabilities!;
    const descriptor: PermissionCapabilityDescriptor = {
      ...base,
      allowedTools: {
        ...base.allowedTools,
        verification: {
          ...base.allowedTools.verification!,
          verifiedVersions: ["1.0.0"],
        },
      },
      mode: {
        ...base.mode,
        verification: {
          ...base.mode.verification!,
          verifiedVersions: ["1.0.0"],
        },
      },
      deniedTools: {
        ...base.deniedTools,
        verification: {
          ...base.deniedTools.verification!,
          verifiedVersions: ["2.0.0"],
        },
      },
    };
    const snapshot = await makeRegistry(
      { [HARNESS_IDS.QWEN_CLI]: "1.0.0" },
      { [HARNESS_IDS.QWEN_CLI]: descriptor }
    ).getInstalledCapabilities(HARNESS_IDS.QWEN_CLI);

    assert.strictEqual(
      snapshot.effective?.permissions?.mode.verification,
      "verified"
    );
    assert.strictEqual(
      snapshot.effective?.permissions?.allowedTools.verification,
      "verified"
    );
    assert.strictEqual(
      snapshot.effective?.permissions?.deniedTools.verification,
      "unknown"
    );
    assert.strictEqual(
      snapshot.effective?.permissions?.deniedTools.fidelity,
      "exact"
    );
  });

  test("does not produce states for unmodeled domains", async () => {
    const registry = makeRegistry();
    assert.strictEqual(
      await registry.getEffectiveCapabilityState(
        HARNESS_IDS.COPILOT_CLI,
        CAPABILITY_DOMAINS.HOOKS,
        "sessionStart"
      ),
      undefined
    );
    const snapshot = await registry.getSnapshot();
    assert.deepStrictEqual(snapshot.enabledDomains, [
      CAPABILITY_DOMAINS.PERMISSIONS,
    ]);
  });

  test("supports an arbitrary enabled domain set and typed leaf dispatch", async () => {
    const registry = makeRegistry(
      {},
      {},
      allHarnessDomainFacts(),
      Object.values(CAPABILITY_DOMAINS)
    );

    const image = await registry.getEffectiveCapabilityState(
      HARNESS_IDS.COPILOT_CLI,
      CAPABILITY_DOMAINS.PROMPT_INPUTS,
      "images"
    );
    const hook = await registry.getEffectiveCapabilityState(
      HARNESS_IDS.COPILOT_CLI,
      CAPABILITY_DOMAINS.HOOKS,
      "stop"
    );
    const mcp = await registry.getEffectiveCapabilityState(
      HARNESS_IDS.COPILOT_CLI,
      CAPABILITY_DOMAINS.MCP,
      "perServerToolFiltering"
    );

    assert.strictEqual(image?.verification, "verified");
    assert.strictEqual(hook?.fidelity, "partial");
    assert.strictEqual(mcp?.mechanism, "workspace-config");
  });

  test("assembles adapter-owned MCP filtering declarations for every harness", async () => {
    const registry = new HarnessCapabilityRegistry({
      enabledDomains: [CAPABILITY_DOMAINS.MCP],
      sourceFactory: (harnessId) => {
        const provider = IntegrationFactory.createCapabilityProvider(harnessId);
        return {
          provider: {
            config: provider.config,
            capabilities: provider.capabilities,
            checkAvailability: async () => true,
            getVersion: async () => "1.0.0",
          },
        };
      },
    });
    const snapshot = await registry.getSnapshot();

    for (const harnessId of HARNESS_ID_LIST) {
      const filtering =
        snapshot.harnesses[harnessId].descriptor.mcp?.perServerToolFiltering;
      assert.ok(filtering);
      assert.ok(filtering.verification);
      assert.ok(filtering.mechanism);
    }
  });

  test("declares every hook event for every harness", async () => {
    const snapshot = await new HarnessCapabilityRegistry({
      enabledDomains: [CAPABILITY_DOMAINS.HOOKS],
    }).getSnapshot();

    for (const harnessId of HARNESS_ID_LIST) {
      const hooks = snapshot.harnesses[harnessId].descriptor.hooks;
      assert.deepStrictEqual(
        Object.keys(hooks ?? {}).sort(),
        [...HOOK_EVENT_ORDER].sort()
      );
      for (const event of HOOK_EVENT_ORDER) {
        assert.ok(hooks?.[event], `${harnessId} is missing ${event}`);
      }
    }
  });

  test("declares the notification support boundary with native evidence", async () => {
    const snapshot = await new HarnessCapabilityRegistry({
      enabledDomains: [CAPABILITY_DOMAINS.HOOKS],
    }).getSnapshot();
    const supported = [
      HARNESS_IDS.CLAUDE_CLI,
      HARNESS_IDS.COPILOT_CLI,
      HARNESS_IDS.QWEN_CLI,
    ];
    const unsupported = [
      HARNESS_IDS.CODEX_CLI,
      HARNESS_IDS.ANTIGRAVITY_CLI,
      HARNESS_IDS.OPENCODE_CLI,
    ];

    for (const harnessId of supported) {
      const declaration = snapshot.harnesses[harnessId].descriptor.hooks
        ?.notification;
      assert.strictEqual(declaration?.fidelity, "exact");
      assert.strictEqual(declaration?.mechanism, "workspace-config");
      assert.ok(declaration?.verification);
    }
    for (const harnessId of unsupported) {
      const declaration = snapshot.harnesses[harnessId].descriptor.hooks
        ?.notification;
      assert.strictEqual(declaration?.fidelity, "unsupported");
      assert.strictEqual(declaration?.mechanism, "none");
    }
  });

  test("rejects incomplete enabled domains and invalid declarations", () => {
    assert.throws(
      () =>
        makeRegistry({}, {}, {}, [
          CAPABILITY_DOMAINS.PERMISSIONS,
          CAPABILITY_DOMAINS.PROMPT_INPUTS,
        ]),
      /Missing capability domain/
    );

    const incomplete = {
      ...mapperFor(HARNESS_IDS.QWEN_CLI).capabilities,
    } as Partial<PermissionCapabilityDescriptor>;
    delete incomplete.deniedTools;
    assert.throws(
      () =>
        makeRegistry(
          {},
          {
            [HARNESS_IDS.QWEN_CLI]:
              incomplete as PermissionCapabilityDescriptor,
          }
        ),
      /Missing capability qwen-cli.permissions.deniedTools/
    );

    const base = mapperFor(HARNESS_IDS.QWEN_CLI).capabilities;
    assert.throws(
      () =>
        makeRegistry(
          {},
          {
            [HARNESS_IDS.QWEN_CLI]: {
              ...base,
              mode: { ...base.mode, fidelity: "unsupported" },
            },
          }
        ),
      /must use mechanism none/
    );
    assert.throws(
      () =>
        makeRegistry(
          {},
          {
            [HARNESS_IDS.QWEN_CLI]: {
              ...base,
              mode: { mechanism: "native" } as unknown as CapabilityDeclaration,
            },
          }
        ),
      /Invalid capability declaration/
    );
    assert.throws(
      () =>
        HarnessCapabilityRegistry.deserializeSnapshot(
          JSON.stringify({ schemaVersion: 1, enabledDomains: ["unknown"] })
        ),
      /Invalid harness capability snapshot shape|Unknown capability domain/
    );
  });

  test("round-trips the schema-versioned snapshot with independent dimensions", async () => {
    const registry = makeRegistry(
      { [HARNESS_IDS.QWEN_CLI]: "0.20.1" },
      {},
      allHarnessDomainFacts(),
      Object.values(CAPABILITY_DOMAINS)
    );
    const serialized = await registry.serializeSnapshot();
    const snapshot = HarnessCapabilityRegistry.deserializeSnapshot(serialized);
    const qwen = snapshot.harnesses[HARNESS_IDS.QWEN_CLI];

    assert.strictEqual(snapshot.schemaVersion, 1);
    assert.strictEqual(qwen.descriptor.permissions?.mode.fidelity, "exact");
    assert.strictEqual(
      qwen.descriptor.permissions?.mode.mechanism,
      "translated-cli"
    );
    assert.strictEqual(
      qwen.effective?.permissions?.mode.verification,
      "verified"
    );
    assert.strictEqual(
      qwen.effective?.promptInputs?.images.verification,
      "verified"
    );
    assert.strictEqual(
      qwen.effective?.mcp?.perServerToolFiltering.mechanism,
      "workspace-config"
    );
  });
});
