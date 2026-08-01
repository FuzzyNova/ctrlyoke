import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HarnessCapabilityRegistry,
} from "../../core/HarnessCapabilityRegistry";
import type { HarnessCapabilitySource } from "../../core/HarnessCapabilityRegistry";
import { AntigravityToolPermissionMapper } from "../../core/harness/antigravity/AntigravityToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../core/harness/claude/ClaudeToolPermissionMapper";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { CopilotToolPermissionMapper } from "../../core/harness/copilot/CopilotToolPermissionMapper";
import { OpenCodeToolPermissionMapper } from "../../core/harness/opencode/OpenCodeToolPermissionMapper";
import { QwenToolPermissionMapper } from "../../core/harness/qwen/QwenToolPermissionMapper";
import type { IToolPermissionMapper } from "../../core/harness/shared/interfaces/IToolPermissionMapper";
import type {
  HarnessConfig,
} from "../../core/harness/shared/interfaces/ICliProvider";
import {
  CAPABILITY_DOMAINS,
  HARNESS_IDS,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { PermissionCapabilityDescriptor } from "../../types/CompatibilityTypes";

const HARNESS_ID_LIST = Object.values(HARNESS_IDS) as HarnessId[];
type CapabilityProvider = HarnessCapabilitySource["provider"];

class DescriptorMapper implements IToolPermissionMapper {
  constructor(readonly capabilities: PermissionCapabilityDescriptor) {}

  buildArgs(): string[] {
    return [];
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
    available = true
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
  > = {}
): HarnessCapabilityRegistry {
  return new HarnessCapabilityRegistry({
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
          version
        ),
      };
    },
  });
}

suite("HarnessCapabilityRegistry", () => {
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
      verified.effective?.permissions.allowedTools.verification,
      "verified"
    );

    const missingVersion = await makeRegistry({
      [HARNESS_IDS.QWEN_CLI]: undefined,
    }).getInstalledCapabilities(HARNESS_IDS.QWEN_CLI);
    assert.strictEqual(missingVersion.version, undefined);
    assert.strictEqual(
      missingVersion.effective?.permissions.allowedTools.verification,
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

    assert.strictEqual(snapshot.effective?.permissions.mode.verification, "verified");
    assert.strictEqual(
      snapshot.effective?.permissions.allowedTools.verification,
      "verified"
    );
    assert.strictEqual(
      snapshot.effective?.permissions.deniedTools.verification,
      "unknown"
    );
    assert.strictEqual(snapshot.effective?.permissions.deniedTools.fidelity, "exact");
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
    assert.deepStrictEqual(snapshot.enabledDomains, [CAPABILITY_DOMAINS.PERMISSIONS]);
  });
});
