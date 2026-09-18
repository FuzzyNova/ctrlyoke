import type {
  WorkflowKey,
  WorkflowViewAddress,
} from "../../types/CtrlYokeTypes";
import { RunLifecycleService } from "./RunLifecycleService";

export interface RevisionAuthorship {
  revision: number;
  authorClientId: string;
  soleAuthorSince: number;
}

class RevisionAuthorLedger {
  private readonly entries = new Map<string, RevisionAuthorship>();

  record(key: string, clientId: string, newRevision: number): void {
    const previous = this.entries.get(key);
    this.entries.set(key, {
      revision: newRevision,
      authorClientId: clientId,
      soleAuthorSince:
        previous?.authorClientId === clientId
          ? previous.soleAuthorSince
          : newRevision,
    });
  }

  /**
   * Reconcile only *forward*, and only within this client's own authorship run.
   *
   * `expected <= entry.revision` is the load-bearing half. The ledger is a
   * whitelist of writes this host performed for a client, so it goes stale the
   * moment anyone else moves the head — a CLI run, an MCP append, the executor
   * persisting its queue, a second extension host. The client then learns the
   * true head by round trip and echoes a revision *newer* than anything the
   * ledger knows. Without this bound that correct expectation is rewritten
   * backwards to a superseded revision, and the on-disk check rejects it: the
   * exact conflict this ledger exists to prevent, except now it is sticky,
   * because `reportActionFailure` republishes the same head the client is
   * already holding and every retry is downgraded again.
   */
  reconcile(key: string, clientId: string, expected: number): number {
    const entry = this.entries.get(key);
    if (
      entry &&
      entry.authorClientId === clientId &&
      expected >= entry.soleAuthorSince - 1 &&
      expected <= entry.revision
    ) {
      return entry.revision;
    }
    return expected;
  }
}

/** Tracks revisions written by this extension host for dashboard clients. */
export class DefinitionAuthorLedger {
  private readonly definitionRevisions = new RevisionAuthorLedger();
  private readonly descriptorRevisions = new RevisionAuthorLedger();

  recordDefinition(
    address: WorkflowViewAddress,
    clientId: string,
    newRevision: number
  ): void {
    this.definitionRevisions.record(
      RunLifecycleService.describeViewAddress(address),
      clientId,
      newRevision
    );
  }

  reconcileDefinition(
    address: WorkflowViewAddress,
    clientId: string,
    expected: number
  ): number {
    return this.definitionRevisions.reconcile(
      RunLifecycleService.describeViewAddress(address),
      clientId,
      expected
    );
  }

  recordDescriptor(
    workflowKey: WorkflowKey,
    clientId: string,
    newRevision: number
  ): void {
    this.descriptorRevisions.record(workflowKey, clientId, newRevision);
  }

  reconcileDescriptor(
    workflowKey: WorkflowKey,
    clientId: string,
    expected: number
  ): number {
    return this.descriptorRevisions.reconcile(workflowKey, clientId, expected);
  }
}
