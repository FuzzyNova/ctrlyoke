import type { WorkspaceSensitiveSettingRequest } from "../../config/WorkspaceSensitiveSettings";
import { workspaceSensitiveSettingRequestKey } from "../../config/WorkspaceSensitiveSettings";
import type {
  WorkspaceSettingTrustDecision,
  WorkspaceSettingsTrustDecisions,
} from "../../config/WorkspaceSettingsTrustStore";
import { TRUST_DECISIONS } from "../../types/DashboardConstants";

/**
 * In-memory stand-in for `WorkspaceSettingsTrustStore`, so tests never write
 * the real `~/.ctrlyoke/workspace-settings-trust.json`. With `allowAll`, it
 * reproduces the pre-gate behaviour for tests about something else.
 */
export class FakeWorkspaceSettingsTrust implements WorkspaceSettingsTrustDecisions {
  readonly decisions = new Map<string, WorkspaceSettingTrustDecision>();
  readonly reported: { identity: string; keys: string[] }[] = [];

  constructor(private readonly allowAll = false) {}

  private static key(
    identity: string,
    request: Pick<
      WorkspaceSensitiveSettingRequest,
      "settingPath" | "fingerprint"
    >
  ): string {
    return `${identity}␟${workspaceSensitiveSettingRequestKey(request)}`;
  }

  getDecision(
    identity: string,
    request: WorkspaceSensitiveSettingRequest
  ): WorkspaceSettingTrustDecision | undefined {
    if (this.allowAll) return TRUST_DECISIONS.ALLOW;
    return this.decisions.get(
      FakeWorkspaceSettingsTrust.key(identity, request)
    );
  }

  async setDecisions(
    identity: string,
    requests: readonly WorkspaceSensitiveSettingRequest[],
    decision: WorkspaceSettingTrustDecision
  ): Promise<void> {
    for (const request of requests) {
      this.decisions.set(
        FakeWorkspaceSettingsTrust.key(identity, request),
        decision
      );
    }
  }

  reportUndecided(
    identity: string,
    requests: readonly WorkspaceSensitiveSettingRequest[]
  ): void {
    this.reported.push({
      identity,
      keys: requests.map((request) =>
        workspaceSensitiveSettingRequestKey(request)
      ),
    });
  }
}
