import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TRUST_DECISIONS } from "../types/DashboardConstants";

/**
 * A user's one-time decision about a workspace-configured external root.
 * "allow" and "deny" are both durable — a denied root stays blocked without
 * re-prompting until the user changes the decision in Settings.
 */
export type ExternalRootTrustDecision =
  (typeof TRUST_DECISIONS)[keyof typeof TRUST_DECISIONS];

interface ExternalRootsTrustFile {
  /** `${scopeIdentity}␟${canonicalRoot}` -> decision */
  decisions: Record<string, ExternalRootTrustDecision>;
}

const DECISION_KEY_SEPARATOR = "␟";

/**
 * User-local store of trust decisions for workspace-scoped
 * `permissions.allowedExternalFileRoots` entries. Never written to workspace
 * or repository config — a workspace only *requests* external roots; whether
 * they actually take effect is decided here, per canonical root and
 * workspace identity, so a compromised/shared workspace config cannot widen
 * filesystem access without a local, reviewed decision.
 *
 * User-scope `allowedExternalFileRoots` entries do not go through this store
 * at all (the user already made that trust decision by editing their own
 * settings) — see `ConfigurationUtils.getEffectiveApprovedExternalFileRoots`.
 *
 * See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md ("Additional Decisions
 * (2026-07-13)").
 */
export class ExternalRootsTrustStore {
  constructor(private readonly storePath: string) {}

  /**
   * Resolve a root to its canonical form for comparison/storage: the real
   * path when the directory exists (so symlinks and case differences
   * collapse to one identity), otherwise the resolved lexical path (the
   * directory may not exist yet, e.g. a log dir created on first harness run).
   */
  static canonicalizeRoot(root: string): string {
    const resolved = path.resolve(root);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }

  private static keyFor(
    scopeIdentity: string,
    canonicalRoot: string
  ): string {
    return `${scopeIdentity}${DECISION_KEY_SEPARATOR}${canonicalRoot}`;
  }

  static canonicalizeWorkflowIdentity(
    workspaceRoot: string,
    workflowSourcePath: string
  ): string {
    const workspaceIdentity =
      ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
    const workflowIdentity =
      ExternalRootsTrustStore.canonicalizeRoot(workflowSourcePath);
    return `workflow:${workspaceIdentity}::${workflowIdentity}`;
  }

  private load(): ExternalRootsTrustFile {
    let content: string;
    try {
      content = fs.readFileSync(this.storePath, "utf-8");
    } catch {
      return { decisions: {} };
    }
    try {
      const parsed = JSON.parse(content) as Partial<ExternalRootsTrustFile>;
      return { decisions: parsed.decisions ?? {} };
    } catch {
      console.warn(
        `[ctrlyoke] External roots trust store has invalid JSON and will be treated as empty: ${this.storePath}`
      );
      return { decisions: {} };
    }
  }

  private async save(data: ExternalRootsTrustFile): Promise<void> {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${this.storePath}.tmp`;
    await fs.promises.writeFile(
      tmpPath,
      JSON.stringify(data, null, 2),
      "utf-8"
    );
    await fs.promises.rename(tmpPath, this.storePath);
  }

  /** Get the recorded decision for a single root, or `undefined` if never decided. */
  getDecision(
    scopeIdentity: string,
    root: string
  ): ExternalRootTrustDecision | undefined {
    const canonicalRoot = ExternalRootsTrustStore.canonicalizeRoot(root);
    return this.load().decisions[
      ExternalRootsTrustStore.keyFor(scopeIdentity, canonicalRoot)
    ];
  }

  /** Filter `candidateRoots` down to those with a recorded `"allow"` decision. */
  getApprovedRoots(
    scopeIdentity: string,
    candidateRoots: readonly string[]
  ): string[] {
    const decisions = this.load().decisions;
    return candidateRoots.filter((root) => {
      const canonicalRoot = ExternalRootsTrustStore.canonicalizeRoot(root);
      return (
        decisions[
          ExternalRootsTrustStore.keyFor(scopeIdentity, canonicalRoot)
        ] === TRUST_DECISIONS.ALLOW
      );
    });
  }

  /** Filter `candidateRoots` down to those with no recorded decision at all. */
  getPendingRoots(
    scopeIdentity: string,
    candidateRoots: readonly string[]
  ): string[] {
    const decisions = this.load().decisions;
    return candidateRoots.filter((root) => {
      const canonicalRoot = ExternalRootsTrustStore.canonicalizeRoot(root);
      return (
        decisions[
          ExternalRootsTrustStore.keyFor(scopeIdentity, canonicalRoot)
        ] === undefined
      );
    });
  }

  /** Record the same decision for a batch of roots in one write. */
  async setDecisions(
    scopeIdentity: string,
    roots: readonly string[],
    decision: ExternalRootTrustDecision
  ): Promise<void> {
    if (roots.length === 0) {
      return;
    }
    const data = this.load();
    for (const root of roots) {
      const canonicalRoot = ExternalRootsTrustStore.canonicalizeRoot(root);
      data.decisions[
        ExternalRootsTrustStore.keyFor(scopeIdentity, canonicalRoot)
      ] = decision;
    }
    await this.save(data);
  }
}

/** Create the trust store backed by `~/.ctrlyoke/external-roots-trust.json`. */
function createExternalRootsTrustStore(): ExternalRootsTrustStore {
  const storePath = path.join(
    os.homedir(),
    ".ctrlyoke",
    "external-roots-trust.json"
  );
  return new ExternalRootsTrustStore(storePath);
}

/** Process-wide singleton, mirroring `configService`. */
export const externalRootsTrustStore = createExternalRootsTrustStore();
