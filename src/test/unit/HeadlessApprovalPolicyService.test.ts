import * as assert from "assert";
import { suite, test } from "mocha";
import { HeadlessApprovalPolicyService } from "../../core/HeadlessApprovalPolicyService";
import {
  APPROVAL_DECISIONS,
  HEADLESS_APPROVAL_DENIAL_MESSAGE,
  HEADLESS_APPROVAL_NO_DASHBOARD_MESSAGE,
  HEADLESS_APPROVAL_POLICIES,
  HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
  HEADLESS_APPROVAL_TIMEOUT_MESSAGE,
  MESSAGE_TYPES,
} from "../../types/DashboardConstants";
import type { HeadlessApprovalRequestMessage } from "../../types/WebviewMessageTypes";
import type { HeadlessApprovalRequestContext } from "../../types/WorkflowContextTypes";

const request: HeadlessApprovalRequestContext = {
  policy: HEADLESS_APPROVAL_POLICIES.ASK,
  workflowId: "workflow-1",
  controlSessionId: "control-1",
  stepIndex: 2,
  harnessId: "claude-cli",
  requestId: "vendor-request-1",
  toolName: "Bash",
  inputSummary: '{"command":"echo hello"}',
  timeoutMs: 1_000,
};

function createService(delivered = true): {
  service: HeadlessApprovalPolicyService;
  messages: HeadlessApprovalRequestMessage[];
} {
  const messages: HeadlessApprovalRequestMessage[] = [];
  return {
    service: new HeadlessApprovalPolicyService((message) => {
      messages.push(message);
      return delivered;
    }),
    messages,
  };
}

suite("HeadlessApprovalPolicyService", function () {
  this.timeout(5_000);

  test("deny answers without registering or publishing a request", async () => {
    const { service, messages } = createService();
    const result = await service.requestApproval(
      HEADLESS_APPROVAL_POLICIES.DENY,
      request,
      new AbortController().signal
    );

    assert.deepStrictEqual(result, {
      decision: APPROVAL_DECISIONS.DENY,
      message: HEADLESS_APPROVAL_DENIAL_MESSAGE,
    });
    assert.deepStrictEqual(messages, []);
    assert.deepStrictEqual(service.getPendingRequests(), []);
  });

  test("ask publishes and accepts allow once", async () => {
    const { service, messages } = createService();
    const pending = service.requestApproval(
      HEADLESS_APPROVAL_POLICIES.ASK,
      request,
      new AbortController().signal
    );
    const published = messages[0];

    assert.strictEqual(
      published.type,
      MESSAGE_TYPES.HEADLESS_APPROVAL_REQUEST_CHANGED
    );
    assert.strictEqual(published.isPending, true);
    assert.strictEqual(published.requestId, request.requestId);
    assert.strictEqual(published.toolName, request.toolName);
    assert.strictEqual(published.stepIndex, request.stepIndex);
    assert.strictEqual(
      service.respond(
        request.controlSessionId,
        published.approvalId,
        APPROVAL_DECISIONS.ALLOW_ONCE
      ),
      true
    );
    assert.deepStrictEqual(await pending, {
      decision: APPROVAL_DECISIONS.ALLOW_ONCE,
    });
    assert.strictEqual(messages[1].approvalId, published.approvalId);
    assert.strictEqual(messages[1].isPending, false);
    assert.deepStrictEqual(service.getPendingRequests(), []);
  });

  test("ask accepts deny with a message", async () => {
    const { service, messages } = createService();
    const pending = service.requestApproval(
      HEADLESS_APPROVAL_POLICIES.ASK,
      request,
      new AbortController().signal
    );
    const approvalId = messages[0].approvalId;

    assert.strictEqual(
      service.respond(
        request.controlSessionId,
        approvalId,
        APPROVAL_DECISIONS.DENY,
        "Do not run this command."
      ),
      true
    );
    assert.deepStrictEqual(await pending, {
      decision: APPROVAL_DECISIONS.DENY,
      message: "Do not run this command.",
    });
  });

  test("timeout is clamped to the supported harness limit", () => {
    assert.strictEqual(
      HeadlessApprovalPolicyService.clampTimeoutMs(120_000, 60_000),
      60_000
    );
    assert.strictEqual(
      HeadlessApprovalPolicyService.clampTimeoutMs(900_000),
      600_000
    );
  });

  test("ask falls back to deny when no dashboard receives the request", async () => {
    const { service, messages } = createService(false);
    const result = await service.requestApproval(
      HEADLESS_APPROVAL_POLICIES.ASK,
      request,
      new AbortController().signal
    );

    assert.deepStrictEqual(result, {
      decision: APPROVAL_DECISIONS.DENY,
      message: HEADLESS_APPROVAL_NO_DASHBOARD_MESSAGE,
    });
    assert.strictEqual(messages[0].isPending, true);
    assert.deepStrictEqual(service.getPendingRequests(), []);
  });

  test("aborting a pending request denies it and publishes removal", async () => {
    const { service, messages } = createService();
    const controller = new AbortController();
    const pending = service.requestApproval(
      HEADLESS_APPROVAL_POLICIES.ASK,
      request,
      controller.signal
    );

    controller.abort();

    assert.deepStrictEqual(await pending, {
      decision: APPROVAL_DECISIONS.DENY,
      message: HEADLESS_APPROVAL_SESSION_CLOSED_MESSAGE,
    });
    assert.strictEqual(messages[1].isPending, false);
    assert.deepStrictEqual(service.getPendingRequests(), []);
  });

  test("timeout denies the request and publishes its removal", async () => {
    const { service, messages } = createService();
    const pending = service.requestApproval(
      HEADLESS_APPROVAL_POLICIES.ASK,
      request,
      new AbortController().signal
    );

    assert.deepStrictEqual(await pending, {
      decision: APPROVAL_DECISIONS.DENY,
      message: HEADLESS_APPROVAL_TIMEOUT_MESSAGE,
    });
    assert.strictEqual(messages[1].isPending, false);
    assert.deepStrictEqual(service.getPendingRequests(), []);
  });
});
