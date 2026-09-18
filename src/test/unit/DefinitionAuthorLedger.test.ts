import { suite, test } from "mocha";
import * as assert from "assert";
import { DefinitionAuthorLedger } from "../../core/orchestration/DefinitionAuthorLedger";
import type {
  RunRef,
  WorkflowKey,
  WorkflowViewAddress,
} from "../../types/CtrlYokeTypes";
import { WORKFLOW_VIEW_ADDRESS_KIND } from "../../types/DashboardConstants";

const WORKFLOW_KEY = "workflow" as WorkflowKey;
const ADDRESS: WorkflowViewAddress = {
  workflowKey: WORKFLOW_KEY,
  kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
  runRef: "run-1" as RunRef,
};

suite("DefinitionAuthorLedger", () => {
  test("reconciles a sole author's stale revision to the head", () => {
    const ledger = new DefinitionAuthorLedger();

    ledger.recordDefinition(ADDRESS, "client-a", 4);

    assert.strictEqual(ledger.reconcileDefinition(ADDRESS, "client-a", 3), 4);
  });

  test("does not reconcile a different client's stale revision", () => {
    const ledger = new DefinitionAuthorLedger();

    ledger.recordDefinition(ADDRESS, "client-a", 4);

    assert.strictEqual(ledger.reconcileDefinition(ADDRESS, "client-b", 3), 3);
  });

  test("does not reconcile an expectation older than the authorship floor", () => {
    const ledger = new DefinitionAuthorLedger();

    ledger.recordDefinition(ADDRESS, "client-a", 4);

    assert.strictEqual(ledger.reconcileDefinition(ADDRESS, "client-a", 2), 2);
  });

  test("stops reconciling the first client after a second client writes", () => {
    const ledger = new DefinitionAuthorLedger();

    ledger.recordDefinition(ADDRESS, "client-a", 4);
    ledger.recordDefinition(ADDRESS, "client-b", 5);

    assert.strictEqual(ledger.reconcileDefinition(ADDRESS, "client-a", 4), 4);
    assert.strictEqual(ledger.reconcileDefinition(ADDRESS, "client-b", 4), 5);
  });

  test("leaves an address with no ledger entry unchanged", () => {
    const ledger = new DefinitionAuthorLedger();

    assert.strictEqual(ledger.reconcileDefinition(ADDRESS, "client-a", 3), 3);
  });

  test("never rewrites an expectation newer than the ledger's head backwards", () => {
    const ledger = new DefinitionAuthorLedger();

    // A foreign writer (CLI, MCP, the executor, a second host) moved the head
    // past anything this ledger recorded, and the client has since caught up.
    ledger.recordDefinition(ADDRESS, "client-a", 4);

    assert.strictEqual(ledger.reconcileDefinition(ADDRESS, "client-a", 5), 5);
  });

  test("never rewrites a newer descriptor expectation backwards", () => {
    const ledger = new DefinitionAuthorLedger();

    ledger.recordDescriptor(WORKFLOW_KEY, "client-a", 4);

    assert.strictEqual(
      ledger.reconcileDescriptor(WORKFLOW_KEY, "client-a", 5),
      5
    );
  });
});
