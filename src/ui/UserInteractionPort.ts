export interface BatchApprovalItem {
  value: string;
  label: string;
  checked: boolean;
}

export interface BatchApprovalRequest {
  id: string;
  title: string;
  description: string;
  items: BatchApprovalItem[];
}

export interface BatchApprovalResult {
  approvedValues: string[];
  deniedValues: string[];
}

export interface ChoiceRequest {
  id: string;
  title: string;
  detail: string;
  choices: { value: string; label: string }[];
}

/**
 * Minimal, reusable capability for asking a connected interactive client to
 * approve/deny a batch of named items via checklist. First caller is
 * workspace secret-grant approval (see SecretGrantsTrustPrompt.ts) — a future
 * batch-approval need (e.g. external file roots) can reuse this port instead
 * of inventing another native-dialog-only flow. Intentionally Node-safe (no
 * `vscode` import) so it can be implemented by any host.
 */
export interface UserInteractionPort {
  /** True if this port can currently show a prompt to a human. */
  canPrompt(): boolean;
  /**
   * Ask the user to approve/deny a batch of items. Resolves to `undefined`
   * when dismissed with no decision (the caller should ask again later) or
   * when `canPrompt()` is false (nothing was shown at all) — the caller is
   * responsible for choosing a deny-by-default policy in that case.
   */
  requestBatchApproval(
    request: BatchApprovalRequest
  ): Promise<BatchApprovalResult | undefined>;
  requestChoice(request: ChoiceRequest): Promise<string | undefined>;
}

/** Always reports "cannot prompt" — the headless/no-client default. */
export class NullUserInteractionPort implements UserInteractionPort {
  canPrompt(): boolean {
    return false;
  }

  async requestBatchApproval(): Promise<BatchApprovalResult | undefined> {
    return undefined;
  }

  async requestChoice(): Promise<string | undefined> {
    return undefined;
  }
}
