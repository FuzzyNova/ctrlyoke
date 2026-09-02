import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  BatchApprovalItem,
  BatchApprovalRequest,
  BatchApprovalResult,
  UserInteractionPort,
} from "./UserInteractionPort";

/**
 * VS Code webview-backed implementation of UserInteractionPort. Posts a
 * SHOW_BATCH_APPROVAL_REQUEST message to the panel and resolves the pending
 * promise when the matching BATCH_APPROVAL_RESPONSE arrives (see
 * `handleResponse`, wired from WebviewMessageRouter). `isClientReady` should
 * reflect whether the panel webview exists AND has completed its READY
 * handshake — posting to a not-yet-ready webview would silently hang.
 */
export class WebviewUserInteractionPort implements UserInteractionPort {
  private readonly pending = new Map<
    string,
    (result: BatchApprovalResult | undefined) => void
  >();

  constructor(
    private readonly postMessage: (message: unknown) => void,
    private readonly isClientReady: () => boolean
  ) {}

  canPrompt(): boolean {
    return this.isClientReady();
  }

  requestBatchApproval(
    request: BatchApprovalRequest
  ): Promise<BatchApprovalResult | undefined> {
    if (!this.canPrompt()) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      this.pending.set(request.id, resolve);
      this.postMessage({
        type: MESSAGE_TYPES.SHOW_BATCH_APPROVAL_REQUEST,
        request: {
          id: request.id,
          title: request.title,
          description: request.description,
          items: request.items.map(
            (item): BatchApprovalItem => ({
              value: item.value,
              label: item.label,
              checked: item.checked,
            })
          ),
        },
      });
    });
  }

  /** Called by the router when BATCH_APPROVAL_RESPONSE arrives from the webview. */
  handleResponse(id: string, result: BatchApprovalResult | undefined): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(result);
  }

  /**
   * Resolve every outstanding request as "dismissed" (undefined) so a closed
   * or disposed panel never leaves a caller awaiting forever. Callers treat
   * this identically to a user pressing Escape — ask again next time.
   */
  disposeAllPending(): void {
    const resolvers = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of resolvers) {
      resolve(undefined);
    }
  }
}
