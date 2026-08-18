import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  HARNESS_IDS,
  HOOK_EVENT_ORDER,
  MCP_CAPABILITY_KEYS,
  PERMISSION_CAPABILITY_KEYS,
  PROMPT_INPUT_CAPABILITY_KEYS,
  type HarnessId,
} from "../types/DashboardConstants";
import type {
  CapabilityDeclaration,
  CapabilityDomain,
  EffectiveCapabilityState,
  HarnessCapabilityFacts,
  HarnessCapabilityRegistrySnapshot,
  HarnessCapabilityDescriptor,
  HarnessVersionRange,
  InstalledHarnessCapabilities,
} from "../types/CompatibilityTypes";
import { IntegrationFactory } from "./IntegrationFactory";
import type { ICliProvider } from "./harness/shared/interfaces/ICliProvider";

export const HARNESS_CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 1;

export interface HarnessCapabilitySource {
  readonly provider: Pick<ICliProvider, "config" | "capabilities"> & {
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
      CAPABILITY_DOMAINS.HOOKS,
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

      HarnessCapabilityRegistry.validateDescriptor(
        harnessId,
        source.provider.capabilities,
        this.enabledDomains
      );
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
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) {
      throw new Error("Invalid harness capability snapshot");
    }
    if (parsed.schemaVersion !== HARNESS_CAPABILITY_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported harness capability snapshot schema: ${String(
          parsed.schemaVersion
        )}`
      );
    }
    if (!Array.isArray(parsed.enabledDomains) || !isRecord(parsed.harnesses)) {
      throw new Error("Invalid harness capability snapshot shape");
    }
    const snapshot = parsed as unknown as HarnessCapabilityRegistrySnapshot;
    HarnessCapabilityRegistry.validateEnabledDomainList(
      snapshot.enabledDomains
    );
    for (const harnessId of HARNESS_ID_LIST) {
      const installed = snapshot.harnesses[harnessId];
      if (!isRecord(installed) || !isRecord(installed.descriptor)) {
        throw new Error(`Missing capability snapshot for harness ${harnessId}`);
      }
      const descriptor =
        installed.descriptor as unknown as HarnessCapabilityDescriptor;
      if (descriptor.harnessId !== harnessId) {
        throw new Error(
          `Capability snapshot ${String(descriptor.harnessId)} is mapped to ${harnessId}`
        );
      }
      HarnessCapabilityRegistry.validateDescriptor(
        harnessId,
        descriptor,
        snapshot.enabledDomains
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
    if (!this.enabledDomains.includes(domain)) {
      return undefined;
    }

    const installed = await this.getInstalledCapabilities(harnessId);
    const domainState = installed.effective[domain];
    if (!domainState || typeof domainState !== "object") {
      return undefined;
    }
    const state = getCapabilityLeaf(domainState, capability);
    return isEffectiveCapabilityState(state) ? state : undefined;
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
    const facts = source.provider.capabilities;
    const descriptor = {
      harnessId: source.provider.config.harnessId,
      ...facts,
    };

    return {
      available,
      ...(version ? { version } : {}),
      descriptor,
      effective: this.resolveEnabledDomains(descriptor, version),
    };
  }

  private resolveEnabledDomains(
    descriptor: HarnessCapabilityDescriptor,
    installedVersion: string | undefined
  ): InstalledHarnessCapabilities["effective"] {
    const effective: Record<string, unknown> = {};
    for (const domain of this.enabledDomains) {
      const domainDescriptor = descriptor[domain];
      if (!domainDescriptor) {
        continue;
      }
      effective[domain] = this.resolveCapabilityValue(
        domainDescriptor,
        installedVersion
      );
    }
    return effective as InstalledHarnessCapabilities["effective"];
  }

  private resolveCapabilityValue(
    value: CapabilityDeclaration | object,
    installedVersion: string | undefined
  ): EffectiveCapabilityState | Record<string, unknown> {
    if (isCapabilityDeclaration(value)) {
      return this.resolveDeclaration(value, installedVersion);
    }
    const resolved: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) {
        resolved[key] = this.resolveCapabilityValue(child, installedVersion);
      }
    }
    return resolved;
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
    HarnessCapabilityRegistry.validateEnabledDomainList(this.enabledDomains);
  }

  private static validateEnabledDomainList(
    enabledDomains: readonly CapabilityDomain[]
  ): void {
    const knownDomains = Object.values(
      CAPABILITY_DOMAINS
    ) as CapabilityDomain[];
    if (new Set(enabledDomains).size !== enabledDomains.length) {
      throw new Error("Harness capability domains must be unique");
    }
    for (const domain of enabledDomains) {
      if (!knownDomains.includes(domain)) {
        throw new Error(`Unknown capability domain ${String(domain)}`);
      }
    }
  }

  private static validateDescriptor(
    harnessId: HarnessId,
    facts: HarnessCapabilityFacts | HarnessCapabilityDescriptor,
    enabledDomains: readonly CapabilityDomain[]
  ): void {
    for (const domain of enabledDomains) {
      const descriptor = facts[domain];
      if (!descriptor) {
        throw new Error(`Missing capability domain ${harnessId}.${domain}`);
      }
      for (const leaf of requiredLeavesForDomain(domain)) {
        if (
          !isRecord(descriptor) ||
          !Object.prototype.hasOwnProperty.call(descriptor, leaf)
        ) {
          throw new Error(`Missing capability ${harnessId}.${domain}.${leaf}`);
        }
      }
      for (const [path, value] of findCapabilityLeaves(descriptor)) {
        if (!isCapabilityDeclaration(value)) {
          throw new Error(
            `Invalid capability declaration ${harnessId}.${domain}.${path}`
          );
        }
        HarnessCapabilityRegistry.validateDeclaration(
          harnessId,
          `${domain}.${path}`,
          value
        );
      }
    }
  }

  private static validateDeclaration(
    harnessId: HarnessId,
    capability: string,
    declaration: CapabilityDeclaration
  ): void {
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
    if (
      declaration.fidelity !== CAPABILITY_FIDELITIES.UNSUPPORTED &&
      (!declaration.verification ||
        declaration.verification.verifiedVersions.length === 0 ||
        !declaration.verification.reference)
    ) {
      throw new Error(
        `Supported capability ${harnessId}.${capability} must include verification evidence`
      );
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

function isCapabilityDeclaration(
  value: unknown
): value is CapabilityDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    "fidelity" in value &&
    "mechanism" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredLeavesForDomain(domain: CapabilityDomain): readonly string[] {
  switch (domain) {
    case CAPABILITY_DOMAINS.PERMISSIONS:
      return Object.values(PERMISSION_CAPABILITY_KEYS);
    case CAPABILITY_DOMAINS.PROMPT_INPUTS:
      return [PROMPT_INPUT_CAPABILITY_KEYS.IMAGES];
    case CAPABILITY_DOMAINS.MCP:
      return [MCP_CAPABILITY_KEYS.PER_SERVER_TOOL_FILTERING];
    case CAPABILITY_DOMAINS.HOOKS:
      return HOOK_EVENT_ORDER;
  }
}

function findCapabilityLeaves(
  value: object,
  prefix = ""
): Array<[string, unknown]> {
  const declarations: Array<[string, unknown]> = [];
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return prefix ? [[prefix, value]] : declarations;
  }
  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isCapabilityDeclaration(child)) {
      declarations.push([path, child]);
    } else if (isRecord(child)) {
      declarations.push(...findCapabilityLeaves(child, path));
    } else {
      declarations.push([path, child]);
    }
  }
  return declarations;
}

function isEffectiveCapabilityState(
  value: unknown
): value is EffectiveCapabilityState {
  return (
    typeof value === "object" &&
    value !== null &&
    "fidelity" in value &&
    "mechanism" in value &&
    "verification" in value
  );
}

function getCapabilityLeaf(value: object, capability: string): unknown {
  return Object.entries(value).find(([key]) => key === capability)?.[1];
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
