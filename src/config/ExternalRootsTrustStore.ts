import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { TRUST_DECISIONS } from "../types/DashboardConstants";
import {
  loadTrustDecisionFile,
  saveTrustDecisionFile,
  type TrustDecisionFile,
} from "./TrustDecisionFile";
import { PERSISTED_STORES } from "../utils/PersistedSchemaGuard";
import { foldPathForCompare } from "../utils/PathCasing";
import { AsyncWriteQueue } from "./AsyncWriteQueue";

/**
 * A user's one-time decision about a workspace-configured external root.
 * "allow" and "deny" are both durable — a denied root stays blocked without
 * re-prompting until the user changes the decision in Settings.
 */
export type ExternalRootTrustDecision =
  (typeof TRUST_DECISIONS)[keyof typeof TRUST_DECISIONS];

/** Keys are `${scopeIdentity}␟${canonicalRoot}`. */
type ExternalRootsTrustFile = TrustDecisionFile<ExternalRootTrustDecision>;

const DECISION_KEY_SEPARATOR = "␟";

/**
 * User-local store of trust decisions for workspace-scoped
 * `permissions.trustedExternalRoots` entries. Never written to workspace
 * or repository config — a workspace only *requests* external roots; whether
 * they actually take effect is decided here, per canonical root and
 * workspace identity, so a compromised/shared workspace config cannot widen
 * filesystem access without a local, reviewed decision.
 *
 * User-scope `trustedExternalRoots` entries do not go through this store
 * at all (the user already made that trust decision by editing their own
 * settings) — see `ConfigurationUtils.getEffectiveApprovedExternalFileRoots`.
 *
 * See dev/backlog/ALLOWED_EXTERNAL_FILE_ROOTS_PLAN.md ("Additional Decisions
 * (2026-07-13)").
 */
export class ExternalRootsTrustStore {
  private readonly writeQueue = new AsyncWriteQueue();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storePath: string) {}

  /**
   * Resolve a root to its canonical form for comparison/storage. Resolving the
   * nearest existing ancestor keeps paths stable while a not-yet-created
   * directory is created; folding then accounts for Windows filesystem
   * case-insensitivity.
   */
  static canonicalizeRoot(root: string): string {
    const resolved = path.resolve(root);
    let existingAncestor = resolved;
    const missingSegments: string[] = [];

    while (true) {
      try {
        const canonicalAncestor = fs.realpathSync.native(existingAncestor);
        return foldPathForCompare(
          path.join(canonicalAncestor, ...missingSegments.reverse())
        );
      } catch {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) {
          return foldPathForCompare(resolved);
        }
        missingSegments.push(path.basename(existingAncestor));
        existingAncestor = parent;
      }
    }
  }

  private static keyFor(scopeIdentity: string, canonicalRoot: string): string {
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
    return loadTrustDecisionFile(
      PERSISTED_STORES.EXTERNAL_ROOTS_TRUST,
      this.storePath,
      "External roots trust store"
    );
  }

  private async save(data: ExternalRootsTrustFile): Promise<void> {
    await saveTrustDecisionFile(
      PERSISTED_STORES.EXTERNAL_ROOTS_TRUST,
      this.storePath,
      data
    );
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
    await this.writeQueue.enqueue(async () => {
      const data = this.load();
      for (const root of roots) {
        const canonicalRoot = ExternalRootsTrustStore.canonicalizeRoot(root);
        data.decisions[
          ExternalRootsTrustStore.keyFor(scopeIdentity, canonicalRoot)
        ] = decision;
      }
      await this.save(data);
    });
    for (const listener of this.listeners) listener();
  }

  /**
   * Run `listener` after each decision this process records. Writes made by
   * another process (the standalone CLI) are not observed.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
