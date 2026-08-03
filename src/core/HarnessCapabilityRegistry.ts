import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  HARNESS_IDS,
  PERMISSION_CAPABILITY_KEYS,
  type HarnessId,
} from "../types/DashboardConstants";
import type {
  CapabilityDeclaration,
  CapabilityDomain,
  EffectiveCapabilityState,
  HarnessCapabilityRegistrySnapshot,
  HarnessVersionRange,
  InstalledHarnessCapabilities,
  PermissionCapabilityDescriptor,
  PermissionCapabilityKey,
} from "../types/CompatibilityTypes";
import { IntegrationFactory } from "./IntegrationFactory";
import type { ICliProvider } from "./harness/shared/interfaces/ICliProvider";

export const HARNESS_CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 1;

export interface HarnessCapabilitySource {
  readonly provider: Pick<ICliProvider, "config" | "toolPermissionMapper"> & {
    checkAvailability(): Promise<boolean>;
    getVersion?(): Promise<string | undefined>;
  };
  /** Optional hook for invalidating the session cache after a status refresh. */
  readonly onStatusChange?: (listener: () => void) => { dispose(): void };
}

export interface HarnessCapabilityRegistryOptions {
  readonly sources?: Partial<Record<HarnessId, HarnessCapabilitySource>>;
  readonly sourceFactory?: (harnessId: HarnessId) => HarnessCapabilitySource;
  readonly enabledDomains?: readonly CapabilityDomain[];
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const HARNESS_ID_LIST = Object.values(HARNESS_IDS) as HarnessId[];

/**
 * Backend assembly for harness capability declarations.
 *
 * This class deliberately knows how to assemble and verify declarations, but
 * never what a harness can do. Those facts are owned by each tool mapper.
 */
export class HarnessCapabilityRegistry {
  private readonly sources = new Map<HarnessId, HarnessCapabilitySource>();
  private readonly installedCache = new Map<
    HarnessId,
    Promise<InstalledHarnessCapabilities>
  >();
  private readonly statusSubscriptions: Array<{ dispose(): void }> = [];
  private readonly enabledDomains: readonly CapabilityDomain[];

  constructor(options: HarnessCapabilityRegistryOptions = {}) {
    this.enabledDomains = options.enabledDomains ?? [
      CAPABILITY_DOMAINS.PERMISSIONS,
    ];
    this.validateEnabledDomains();

    for (const harnessId of HARNESS_ID_LIST) {
      const source =
        options.sources?.[harnessId] ??
        options.sourceFactory?.(harnessId) ??
        HarnessCapabilityRegistry.createDefaultSource(harnessId);
      this.sources.set(harnessId, source);
      this.statusSubscriptions.push(
        ...(source.onStatusChange
          ? [source.onStatusChange(() => this.invalidate(harnessId))]
          : [])
      );
    }

    this.validateCompleteness();
  }

  /** Validate the enabled rollout boundary and every enabled harness domain. */
  validateCompleteness(): void {
    this.validateEnabledDomains();

    for (const harnessId of HARNESS_ID_LIST) {
      const source = this.sources.get(harnessId);
      if (!source) {
        throw new Error(`Missing capability source for harness ${harnessId}`);
      }
      if (source.provider.config.harnessId !== harnessId) {
        throw new Error(
          `Capability source ${source.provider.config.harnessId} is mapped to ${harnessId}`
        );
      }

      const descriptor = source.provider.toolPermissionMapper.capabilities;
      this.validatePermissionDescriptor(harnessId, descriptor);
    }
  }

  /** Return the cached installed state, detecting the harness at most once. */
  async getInstalledCapabilities(
    harnessId: HarnessId
  ): Promise<InstalledHarnessCapabilities> {
    const cached = this.installedCache.get(harnessId);
    if (cached) {
      return cached;
    }

    const source = this.requireSource(harnessId);
    const detection = this.detectInstalledCapabilities(source);
    this.installedCache.set(harnessId, detection);
    return detection;
  }

  /** Build a serializable snapshot for the currently enabled domains. */
  async getSnapshot(): Promise<HarnessCapabilityRegistrySnapshot> {
    const entries = await Promise.all(
      HARNESS_ID_LIST.map(
        async (harnessId) =>
          [harnessId, await this.getInstalledCapabilities(harnessId)] as const
      )
    );

    return {
      schemaVersion: HARNESS_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      enabledDomains: [...this.enabledDomains],
      harnesses: Object.fromEntries(entries) as Record<
        HarnessId,
        InstalledHarnessCapabilities
      >,
    };
  }

  async serializeSnapshot(): Promise<string> {
    return JSON.stringify(await this.getSnapshot());
  }

  static deserializeSnapshot(
    serialized: string
  ): HarnessCapabilityRegistrySnapshot {
    const snapshot = JSON.parse(
      serialized
    ) as HarnessCapabilityRegistrySnapshot;
    if (snapshot.schemaVersion !== HARNESS_CAPABILITY_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported harness capability snapshot schema: ${String(
          snapshot.schemaVersion
        )}`
      );
    }
    if (
      snapshot.enabledDomains.length !== 1 ||
      snapshot.enabledDomains[0] !== CAPABILITY_DOMAINS.PERMISSIONS
    ) {
      throw new Error(
        "Harness capability snapshots must enable permissions only"
      );
    }
    return snapshot;
  }

  /**
   * Resolve one enabled capability. Unmodeled domains intentionally return
   * undefined rather than an unsupported or unknown state.
   */
  async getEffectiveCapabilityState(
    harnessId: HarnessId,
    domain: CapabilityDomain,
    capability: string
  ): Promise<EffectiveCapabilityState | undefined> {
    if (
      domain !== CAPABILITY_DOMAINS.PERMISSIONS ||
      !this.enabledDomains.includes(domain)
    ) {
      return undefined;
    }

    const installed = await this.getInstalledCapabilities(harnessId);
    const key = capability as PermissionCapabilityKey;
    return installed.effective?.permissions[key];
  }

  /** Re-run availability/version detection for one harness or the full set. */
  async refresh(harnessId?: HarnessId): Promise<void> {
    this.invalidate(harnessId);
    if (harnessId) {
      await this.getInstalledCapabilities(harnessId);
      return;
    }
    await Promise.all(
      HARNESS_ID_LIST.map((id) => this.getInstalledCapabilities(id))
    );
  }

  /** Invalidate cached installed availability and version information. */
  invalidate(harnessId?: HarnessId): void {
    if (harnessId) {
      this.installedCache.delete(harnessId);
      return;
    }
    this.installedCache.clear();
  }

  dispose(): void {
    for (const subscription of this.statusSubscriptions) {
      subscription.dispose();
    }
    this.statusSubscriptions.length = 0;
    this.installedCache.clear();
  }

  private async detectInstalledCapabilities(
    source: HarnessCapabilitySource
  ): Promise<InstalledHarnessCapabilities> {
    const available = await source.provider.checkAvailability();
    const version = available
      ? await source.provider.getVersion?.()
      : undefined;
    const permissionCapabilities =
      source.provider.toolPermissionMapper.capabilities;
    const descriptor = {
      harnessId: source.provider.config.harnessId,
      permissions: permissionCapabilities,
    };

    return {
      available,
      ...(version ? { version } : {}),
      descriptor,
      effective: {
        permissions: {
          mode: this.resolveDeclaration(permissionCapabilities.mode, version),
          allowedTools: this.resolveDeclaration(
            permissionCapabilities.allowedTools,
            version
          ),
          deniedTools: this.resolveDeclaration(
            permissionCapabilities.deniedTools,
            version
          ),
        },
      },
    };
  }

  private resolveDeclaration(
    declaration: CapabilityDeclaration,
    installedVersion: string | undefined
  ): EffectiveCapabilityState {
    const verified = Boolean(
      installedVersion &&
      declaration.verification?.verifiedVersions.some((range) =>
        versionSatisfies(installedVersion, range)
      )
    );

    return {
      fidelity: declaration.fidelity,
      mechanism: declaration.mechanism,
      verification: verified ? "verified" : "unknown",
    };
  }

  private validateEnabledDomains(): void {
    if (
      this.enabledDomains.length !== 1 ||
      this.enabledDomains[0] !== CAPABILITY_DOMAINS.PERMISSIONS
    ) {
      throw new Error("Only the permissions capability domain is modeled");
    }
  }

  private validatePermissionDescriptor(
    harnessId: HarnessId,
    descriptor: PermissionCapabilityDescriptor
  ): void {
    const capabilities = Object.values(
      PERMISSION_CAPABILITY_KEYS
    ) as PermissionCapabilityKey[];
    for (const capability of capabilities) {
      const declaration = descriptor[capability];
      if (!declaration) {
        throw new Error(
          `Missing permission capability ${harnessId}.${capability}`
        );
      }
      if (
        declaration.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED &&
        declaration.mechanism !== CAPABILITY_MECHANISMS.NONE
      ) {
        throw new Error(
          `Unsupported capability ${harnessId}.${capability} must use mechanism none`
        );
      }
      if (
        declaration.fidelity !== CAPABILITY_FIDELITIES.UNSUPPORTED &&
        declaration.mechanism === CAPABILITY_MECHANISMS.NONE
      ) {
        throw new Error(
          `Supported capability ${harnessId}.${capability} cannot use mechanism none`
        );
      }
    }
  }

  private requireSource(harnessId: HarnessId): HarnessCapabilitySource {
    const source = this.sources.get(harnessId);
    if (!source) {
      throw new Error(`Missing capability source for harness ${harnessId}`);
    }
    return source;
  }

  private static createDefaultSource(
    harnessId: HarnessId
  ): HarnessCapabilitySource {
    return { provider: IntegrationFactory.createCapabilityProvider(harnessId) };
  }
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

type VersionComparator = ">" | ">=" | "<" | "<=" | "=" | "";

const VERSION_COMPARATORS: Record<
  VersionComparator,
  (comparison: number) => boolean
> = {
  ">": (comparison) => comparison > 0,
  ">=": (comparison) => comparison >= 0,
  "<": (comparison) => comparison < 0,
  "<=": (comparison) => comparison <= 0,
  "=": (comparison) => comparison === 0,
  "": (comparison) => comparison === 0,
};

function satisfiesComparator(
  version: ParsedVersion,
  operator: string,
  target: ParsedVersion
): boolean {
  const comparison = compareVersions(version, target);
  return operator in VERSION_COMPARATORS
    ? VERSION_COMPARATORS[operator as VersionComparator](comparison)
    : false;
}

/** Small semver-range evaluator for the declaration ranges used by the registry. */
export function versionSatisfies(
  installedVersion: string,
  range: HarnessVersionRange
): boolean {
  const version = parseVersion(installedVersion);
  if (!version) {
    return false;
  }

  return range.split("||").some((alternative) => {
    const expression = alternative.trim();
    if (!expression || expression === "*" || expression.toLowerCase() === "x") {
      return true;
    }

    if (expression.startsWith("^") || expression.startsWith("~")) {
      const operator = expression[0];
      const target = parseVersion(expression.slice(1));
      if (!target) {
        return false;
      }
      const upper =
        operator === "^"
          ? target.major > 0
            ? { major: target.major + 1, minor: 0, patch: 0 }
            : target.minor > 0
              ? { major: 0, minor: target.minor + 1, patch: 0 }
              : { major: 0, minor: 0, patch: target.patch + 1 }
          : { major: target.major, minor: target.minor + 1, patch: 0 };
      return (
        compareVersions(version, target) >= 0 &&
        compareVersions(version, upper) < 0
      );
    }

    return expression.split(/\s+/).every((token) => {
      const match = token.match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}|[xX*])$/);
      if (!match) {
        return false;
      }
      if (/^[xX*]$/.test(match[2])) {
        return true;
      }
      const target = parseVersion(match[2]);
      return target
        ? satisfiesComparator(version, match[1] ?? "", target)
        : false;
    });
  });
}
