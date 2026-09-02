import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ExternalRootsTrustStore } from "./ExternalRootsTrustStore";
import { TRUST_DECISIONS } from "../types/DashboardConstants";

export type SecretGrantTrustDecision =
  (typeof TRUST_DECISIONS)[keyof typeof TRUST_DECISIONS];

interface SecretGrantsTrustFile {
  /** `${workspaceIdentity}␟${secretName}` -> decision */
  decisions: Record<string, SecretGrantTrustDecision>;
}

const DECISION_KEY_SEPARATOR = "␟";

/**
 * User-local store of trust decisions for workflow secret grants. Approval is
 * scoped to the canonical workspace identity and secret name, never workspace
 * configuration.
 */
export class SecretGrantsTrustStore {
  constructor(private readonly storePath: string) {}

  private static keyFor(workspaceIdentity: string, secretName: string): string {
    return `${workspaceIdentity}${DECISION_KEY_SEPARATOR}${secretName}`;
  }

  private static canonicalWorkspaceIdentity(workspaceIdentity: string): string {
    return ExternalRootsTrustStore.canonicalizeRoot(workspaceIdentity);
  }

  private load(): SecretGrantsTrustFile {
    let content: string;
    try {
      content = fs.readFileSync(this.storePath, "utf-8");
    } catch {
      return { decisions: {} };
    }
    try {
      const parsed = JSON.parse(content) as Partial<SecretGrantsTrustFile>;
      return { decisions: parsed.decisions ?? {} };
    } catch {
      console.warn(
        `[ctrlyoke] Secret grants trust store has invalid JSON and will be treated as empty: ${this.storePath}`
      );
      return { decisions: {} };
    }
  }

  private async save(data: SecretGrantsTrustFile): Promise<void> {
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

  /** Get the recorded decision for a single grant, or undefined if pending. */
  getDecision(
    workspaceIdentity: string,
    secretName: string
  ): SecretGrantTrustDecision | undefined {
    const identity =
      SecretGrantsTrustStore.canonicalWorkspaceIdentity(workspaceIdentity);
    return this.load().decisions[
      SecretGrantsTrustStore.keyFor(identity, secretName)
    ];
  }

  /** Filter candidate names down to those with an allow decision. */
  getApprovedGrants(
    workspaceIdentity: string,
    candidateNames: readonly string[]
  ): string[] {
    const identity =
      SecretGrantsTrustStore.canonicalWorkspaceIdentity(workspaceIdentity);
    const decisions = this.load().decisions;
    return candidateNames.filter(
      (name) =>
        decisions[SecretGrantsTrustStore.keyFor(identity, name)] ===
        TRUST_DECISIONS.ALLOW
    );
  }

  /** Filter candidate names down to those with no recorded decision. */
  getPendingGrants(
    workspaceIdentity: string,
    candidateNames: readonly string[]
  ): string[] {
    const identity =
      SecretGrantsTrustStore.canonicalWorkspaceIdentity(workspaceIdentity);
    const decisions = this.load().decisions;
    return candidateNames.filter(
      (name) =>
        decisions[SecretGrantsTrustStore.keyFor(identity, name)] === undefined
    );
  }

  /** Record the same decision for a batch of grants in one write. */
  async setDecisions(
    workspaceIdentity: string,
    names: readonly string[],
    decision: SecretGrantTrustDecision
  ): Promise<void> {
    if (names.length === 0) {
      return;
    }
    const identity =
      SecretGrantsTrustStore.canonicalWorkspaceIdentity(workspaceIdentity);
    const data = this.load();
    for (const name of names) {
      data.decisions[SecretGrantsTrustStore.keyFor(identity, name)] = decision;
    }
    await this.save(data);
  }
}

/** Create the trust store backed by `~/.ctrlyoke/secret-grants-trust.json`. */
function createSecretGrantsTrustStore(): SecretGrantsTrustStore {
  const storePath = path.join(
    os.homedir(),
    ".ctrlyoke",
    "secret-grants-trust.json"
  );
  return new SecretGrantsTrustStore(storePath);
}

/** Process-wide singleton for secret-grant trust decisions. */
export const secretGrantsTrustStore = createSecretGrantsTrustStore();
