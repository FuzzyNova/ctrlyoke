import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import type { HarnessIntegration } from "../../core/HarnessIntegration";
import { IntegrationFactory } from "../../core/IntegrationFactory";
import { WorkflowInstance } from "../../core/WorkflowInstance";
import { MockHarnessIntegration, MockPlatform } from "../helpers/mockHarness";
import {
  EXECUTION_MODES,
  EXECUTION_STATES,
  HARNESS_IDS,
  APPROVAL_DECISIONS,
  CLI_EVENT_TYPES,
  HEADLESS_APPROVAL_TIMEOUT_MESSAGE,
  HEADLESS_APPROVAL_POLICIES,
  HEADLESS_STEER_DELIVERIES,
  MESSAGE_TYPES,
  PERMISSION_MODES,
  STEP_STATUS,
  type HarnessId,
} from "../../types/DashboardConstants";
import type { CliEvent } from "../../types/CliOutputTypes";
import type { PromptFile, PromptStep } from "../../types/CtrlYokeTypes";
import type { ExecutionWorkspace } from "../../types/WorkflowContextTypes";
import type {
  HeadlessApprovalRequestMessage,
  HeadlessControlTargetMessage,
} from "../../types/WebviewMessageTypes";
import { PostMessageDashboardSink } from "../../ui/PostMessageDashboardSink";
import { removeTempDir } from "../helpers/tempWorkspace";
import {
  initializeRunHistoryLocation,
  isRunHistoryLocationInitialized,
  resetRunHistoryLocationForTests,
} from "../../utils/RunHistoryStoragePolicy";
import { configService } from "../../config/CtrlYokeConfigService";
import { COPILOT_ACP_MIN_VERSION } from "../../core/harness/copilot/CopilotHarnessAdapter";
import { OPENCODE_HEADLESS_CONTROL_MIN_VERSION } from "../../core/harness/opencode/OpenCodeProtocolConstants";
import { versionSatisfies } from "../../utils/HarnessVersion";
import {
  HARNESS_MODELS,
  HARNESS_TIMEOUT_MS,
  isolateRunState,
  makeHarnessWorkspaceDir,
} from "./helpers/harnessRunner";

class SteeringIntegrationFactory extends IntegrationFactory {
  integration?: HarnessIntegration;

  override createForExecution(
    harness: HarnessId,
    executionWorkspace?: ExecutionWorkspace
  ): HarnessIntegration {
    const integration = super.createForExecution(harness, executionWorkspace);
    this.integration = integration;
    return integration;
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function findPendingApproval(
  messages: readonly unknown[]
): HeadlessApprovalRequestMessage | undefined {
  return messages.find(
    (message): message is HeadlessApprovalRequestMessage =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === MESSAGE_TYPES.HEADLESS_APPROVAL_REQUEST_CHANGED &&
      "isPending" in message &&
      message.isPending === true
  );
}

async function runOpenCodeApprovalCase(
  scenario: "allow" | "deny" | "timeout",
  waitBeforeDecisionMs = 0
): Promise<void> {
  const harness = HARNESS_IDS.OPENCODE_CLI;
  const workspace = makeHarnessWorkspaceDir(
    harness,
    `ctrlyoke-headless-approval-opencode-${scenario}-`
  );
  const restoreRunState = isolateRunState(workspace);
  const hadRunHistoryLocation = isRunHistoryLocationInitialized();
  if (!hadRunHistoryLocation) {
    initializeRunHistoryLocation(
      configService.get("storage").runHistoryLocation
    );
  }
  let instance: WorkflowInstance | undefined;
  let execution: Promise<void> | undefined;
  let executionSettled = false;
  const dashboardMessages: unknown[] = [];
  const events: CliEvent[] = [];

  try {
    const markerPath = path.join(workspace, "open-code-approved-once.txt");
    const command = `node -e "require('fs').writeFileSync('${markerPath.replace(/\\/g, "/")}','allowed')"`;
    const workflow: PromptFile = {
      name: `OpenCode headless approval ${scenario}`,
      harness,
      model: HARNESS_MODELS[harness],
      executionMode: EXECUTION_MODES.HEADLESS,
      resumeSession: false,
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [],
        deniedTools: [],
        headlessApprovals: HEADLESS_APPROVAL_POLICIES.ASK,
        headlessApprovalTimeoutSec: scenario === "timeout" ? 1 : 60,
      },
      steps: [
        {
          name: "approval-required command",
          prompt: [
            "Run this exact command once:",
            command,
            "If it is denied, do not retry or use another tool.",
            "Reply only with the result and the exact permission message.",
          ].join("\n"),
        },
      ],
    };
    const workflowFile = path.join(
      workspace,
      `opencode-headless-approval-${scenario}.ctrlyoke.json`
    );
    await fs.promises.writeFile(
      workflowFile,
      JSON.stringify(workflow, null, 2),
      "utf8"
    );

    const platform = new MockPlatform(workspace);
    const integrationFactory = new SteeringIntegrationFactory(platform);
    instance = new WorkflowInstance(
      platform,
      new PostMessageDashboardSink((message) =>
        dashboardMessages.push(message)
      ),
      integrationFactory,
      () => new MockHarnessIntegration(undefined, false),
      () => {},
      () => {},
      workspace
    );
    instance.onStreamingEvents((next) => events.push(...next));
    assert.strictEqual(await instance.loadPromptFile(workflowFile), true);
    execution = instance
      .executeLoadedPromptFile()
      .finally(() => (executionSettled = true));

    const approval = await waitFor(
      () => findPendingApproval(dashboardMessages),
      `OpenCode ${scenario} approval request`
    );
    if (scenario !== "timeout") {
      if (waitBeforeDecisionMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, waitBeforeDecisionMs)
        );
      }
      assert.strictEqual(
        instance.respondToHeadlessApproval(
          approval.controlSessionId,
          approval.approvalId,
          scenario === "allow"
            ? APPROVAL_DECISIONS.ALLOW_ONCE
            : APPROVAL_DECISIONS.DENY,
          scenario === "deny" ? "ctrlyoke test denial" : undefined
        ),
        true
      );
    }

    await execution;
    const eventText = JSON.stringify(events);
    if (scenario === "allow") {
      assert.strictEqual(
        await fs.promises.readFile(markerPath, "utf8"),
        "allowed"
      );
    } else {
      assert.strictEqual(fs.existsSync(markerPath), false);
      assert.ok(
        eventText.includes(
          scenario === "deny"
            ? "ctrlyoke test denial"
            : HEADLESS_APPROVAL_TIMEOUT_MESSAGE
        ),
        `OpenCode did not receive the ${scenario} reason`
      );
    }
    assert.ok(
      events.some((event) => event.type === CLI_EVENT_TYPES.BASH_COMMAND),
      "OpenCode JSONL parser did not preserve the command event"
    );
    assert.strictEqual(
      instance.promptQueue.getState().results[0]?.status,
      STEP_STATUS.COMPLETED
    );
  } finally {
    if (execution && instance && !executionSettled) {
      await instance.stop();
      await execution.catch(() => undefined);
    }
    await instance?.outputHistoryManager.flushPendingIndexRefresh();
    instance?.dispose();
    restoreRunState();
    if (!hadRunHistoryLocation) resetRunHistoryLocationForTests();
    removeTempDir(workspace, (dir) =>
      console.log(`  Could not clean up ${dir}`)
    );
  }
}

suite("Headless steering harness tests", function () {
  this.timeout(HARNESS_TIMEOUT_MS);

  for (const harness of [
    HARNESS_IDS.CLAUDE_CLI,
    HARNESS_IDS.QWEN_CLI,
    HARNESS_IDS.CODEX_CLI,
    HARNESS_IDS.OPENCODE_CLI,
    HARNESS_IDS.ANTIGRAVITY_CLI,
    HARNESS_IDS.COPILOT_CLI,
  ] as const) {
    test(`${harness}: headless steering reaches the same step`, async function () {
      const provider = IntegrationFactory.createCapabilityProvider(harness);
      if (!(await provider.checkAvailability())) {
        this.skip();
      }
      if (harness === HARNESS_IDS.COPILOT_CLI) {
        const version = await provider.getVersion?.();
        if (
          !version ||
          !versionSatisfies(version, `>=${COPILOT_ACP_MIN_VERSION}`)
        ) {
          this.skip();
        }
      }
      if (harness === HARNESS_IDS.OPENCODE_CLI) {
        const version = await provider.getVersion?.();
        if (
          !version ||
          !versionSatisfies(
            version,
            `>=${OPENCODE_HEADLESS_CONTROL_MIN_VERSION}`
          )
        ) {
          this.skip();
        }
      }

      const workspace = makeHarnessWorkspaceDir(
        harness,
        `ctrlyoke-headless-steer-${harness}-`
      );
      const restoreRunState = isolateRunState(workspace);
      const hadRunHistoryLocation = isRunHistoryLocationInitialized();
      if (!hadRunHistoryLocation) {
        initializeRunHistoryLocation(
          configService.get("storage").runHistoryLocation
        );
      }
      let instance: WorkflowInstance | undefined;
      let execution: Promise<void> | undefined;
      let executionSettled = false;
      const events: CliEvent[] = [];
      let unsubscribeEvents: { dispose(): void } | undefined;
      const dashboardMessages: unknown[] = [];

      try {
        const prompt: PromptStep = {
          name: "slow command",
          prompt: [
            "Run this exact shell command, wait for it to finish, then reply with only DONE:",
            "node -e \"require('fs').writeFileSync('headless-steer-ready.txt','ready');setTimeout(()=>console.log('SLOW_COMMAND_DONE'),15000)\"",
          ].join("\n"),
        };
        const workflow: PromptFile = {
          name: `headless steer ${harness}`,
          harness,
          model: HARNESS_MODELS[harness],
          executionMode: EXECUTION_MODES.HEADLESS,
          resumeSession: false,
          toolPermissions: {
            mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
          },
          steps: [prompt],
        };
        const workflowFile = path.join(
          workspace,
          `headless-steer-${harness}.ctrlyoke.json`
        );
        await fs.promises.writeFile(
          workflowFile,
          JSON.stringify(workflow, null, 2),
          "utf8"
        );

        const platform = new MockPlatform(workspace);
        const integrationFactory = new SteeringIntegrationFactory(platform);
        const detector = new MockHarnessIntegration(undefined, false);
        instance = new WorkflowInstance(
          platform,
          new PostMessageDashboardSink((message) =>
            dashboardMessages.push(message)
          ),
          integrationFactory,
          () => detector,
          () => {},
          () => {},
          workspace
        );
        unsubscribeEvents = instance.onStreamingEvents((next) =>
          events.push(...next)
        );

        assert.strictEqual(await instance.loadPromptFile(workflowFile), true);
        execution = instance
          .executeLoadedPromptFile()
          .finally(() => (executionSettled = true));

        const controlSessionId = await waitFor(
          () => integrationFactory.integration?.getHeadlessControlSessionId(),
          `${harness} headless control channel`
        );
        await waitFor(
          () =>
            fs.existsSync(path.join(workspace, "headless-steer-ready.txt"))
              ? true
              : undefined,
          `${harness} slow command`
        );

        await instance.sendSteerMessage(
          controlSessionId,
          "The secret word is PINEAPPLE. Include it in your final answer."
        );
        await execution;

        const response = events
          .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
          .map((event) => {
            const data = event.data as { text?: unknown } | undefined;
            return typeof data?.text === "string" ? data.text : "";
          })
          .join("\n");
        assert.match(
          response,
          /\bPINEAPPLE\b/i,
          `${harness}: the steered answer was not in the step's text output`
        );
        assert.strictEqual(
          events.filter((event) => event.type === CLI_EVENT_TYPES.USER_STEER)
            .length,
          1,
          `${harness}: the steer receipt was duplicated`
        );
        assert.strictEqual(
          instance.promptQueue.getState().status,
          EXECUTION_STATES.COMPLETED,
          `${harness}: the workflow did not complete`
        );
        assert.strictEqual(
          instance.promptQueue.getState().results[0]?.status,
          STEP_STATUS.COMPLETED,
          `${harness}: the steered step did not complete`
        );

        const targetMessages = dashboardMessages.filter(
          (message): message is HeadlessControlTargetMessage =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === MESSAGE_TYPES.HEADLESS_CONTROL_TARGET_CHANGED
        );
        assert.deepStrictEqual(
          targetMessages.map(
            ({
              controlSessionId: id,
              isOpen,
              canInterruptTurn,
              steerDelivery,
            }) => ({
              controlSessionId: id,
              canInterruptTurn,
              isOpen,
              steerDelivery,
            })
          ),
          [
            {
              controlSessionId,
              canInterruptTurn:
                harness !== HARNESS_IDS.ANTIGRAVITY_CLI &&
                harness !== HARNESS_IDS.COPILOT_CLI &&
                harness !== HARNESS_IDS.OPENCODE_CLI,
              isOpen: true,
              steerDelivery:
                harness === HARNESS_IDS.COPILOT_CLI ||
                harness === HARNESS_IDS.QWEN_CLI ||
                harness === HARNESS_IDS.ANTIGRAVITY_CLI
                  ? HEADLESS_STEER_DELIVERIES.QUEUE
                  : HEADLESS_STEER_DELIVERIES.INJECT,
            },
            {
              controlSessionId,
              canInterruptTurn:
                harness !== HARNESS_IDS.ANTIGRAVITY_CLI &&
                harness !== HARNESS_IDS.COPILOT_CLI &&
                harness !== HARNESS_IDS.OPENCODE_CLI,
              isOpen: false,
              steerDelivery:
                harness === HARNESS_IDS.COPILOT_CLI ||
                harness === HARNESS_IDS.QWEN_CLI ||
                harness === HARNESS_IDS.ANTIGRAVITY_CLI
                  ? HEADLESS_STEER_DELIVERIES.QUEUE
                  : HEADLESS_STEER_DELIVERIES.INJECT,
            },
          ]
        );
      } finally {
        if (execution && instance && !executionSettled) {
          await instance.stop();
          await execution.catch(() => undefined);
        }
        unsubscribeEvents?.dispose();
        await instance?.outputHistoryManager.flushPendingIndexRefresh();
        instance?.dispose();
        restoreRunState();
        if (!hadRunHistoryLocation) resetRunHistoryLocationForTests();
        removeTempDir(workspace, (dir) =>
          console.log(`  Could not clean up ${dir}`)
        );
      }
    });

    if (harness === HARNESS_IDS.COPILOT_CLI) {
      test(`${harness}: headless approval ask allows one requested tool call`, async function () {
        const provider = IntegrationFactory.createCapabilityProvider(harness);
        if (!(await provider.checkAvailability())) {
          this.skip();
        }
        const version = await provider.getVersion?.();
        if (
          !version ||
          !versionSatisfies(version, `>=${COPILOT_ACP_MIN_VERSION}`)
        ) {
          this.skip();
        }

        const workspace = makeHarnessWorkspaceDir(
          harness,
          `ctrlyoke-headless-approval-${harness}-`
        );
        const restoreRunState = isolateRunState(workspace);
        const hadRunHistoryLocation = isRunHistoryLocationInitialized();
        if (!hadRunHistoryLocation) {
          initializeRunHistoryLocation(
            configService.get("storage").runHistoryLocation
          );
        }
        let instance: WorkflowInstance | undefined;
        let execution: Promise<void> | undefined;
        let executionSettled = false;
        const dashboardMessages: unknown[] = [];

        try {
          const markerPath = path.join(workspace, "approved-once.txt");
          const command = `node -e "require('fs').writeFileSync('${markerPath.replace(/\\/g, "/")}','allowed')"`;
          const workflow: PromptFile = {
            name: "Copilot headless approval",
            harness,
            model: HARNESS_MODELS[harness],
            executionMode: EXECUTION_MODES.HEADLESS,
            resumeSession: false,
            toolPermissions: {
              mode: PERMISSION_MODES.CUSTOM,
              allowedTools: ["shell(echo:*)"],
              deniedTools: ["write"],
              headlessApprovals: HEADLESS_APPROVAL_POLICIES.ASK,
              headlessApprovalTimeoutSec: 30,
            },
            steps: [
              {
                name: "approval-required command",
                prompt: [
                  "Run exactly this command once, then reply with only DONE:",
                  command,
                  "Do not retry or use another tool if it is denied.",
                ].join("\n"),
              },
            ],
          };
          const workflowFile = path.join(
            workspace,
            "copilot-headless-approval.ctrlyoke.json"
          );
          await fs.promises.writeFile(
            workflowFile,
            JSON.stringify(workflow, null, 2),
            "utf8"
          );

          const platform = new MockPlatform(workspace);
          const integrationFactory = new SteeringIntegrationFactory(platform);
          instance = new WorkflowInstance(
            platform,
            new PostMessageDashboardSink((message) =>
              dashboardMessages.push(message)
            ),
            integrationFactory,
            () => new MockHarnessIntegration(undefined, false),
            () => {},
            () => {},
            workspace
          );
          assert.strictEqual(await instance.loadPromptFile(workflowFile), true);
          execution = instance
            .executeLoadedPromptFile()
            .finally(() => (executionSettled = true));

          const approval = await waitFor(
            () =>
              dashboardMessages.find(
                (message): message is HeadlessApprovalRequestMessage =>
                  typeof message === "object" &&
                  message !== null &&
                  "type" in message &&
                  message.type ===
                    MESSAGE_TYPES.HEADLESS_APPROVAL_REQUEST_CHANGED &&
                  "isPending" in message &&
                  message.isPending === true
              ),
            "Copilot headless approval request"
          );
          assert.strictEqual(
            instance.respondToHeadlessApproval(
              approval.controlSessionId,
              approval.approvalId,
              APPROVAL_DECISIONS.ALLOW_ONCE
            ),
            true
          );
          await execution;

          assert.strictEqual(
            await fs.promises.readFile(markerPath, "utf8"),
            "allowed"
          );
          assert.ok(
            dashboardMessages.some(
              (message): message is HeadlessApprovalRequestMessage =>
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type ===
                  MESSAGE_TYPES.HEADLESS_APPROVAL_REQUEST_CHANGED &&
                "approvalId" in message &&
                message.approvalId === approval.approvalId &&
                "isPending" in message &&
                message.isPending === false
            ),
            "Copilot approval request was not cleared after the response"
          );
          assert.strictEqual(
            instance.promptQueue.getState().results[0]?.status,
            STEP_STATUS.COMPLETED
          );
        } finally {
          if (execution && instance && !executionSettled) {
            await instance.stop();
            await execution.catch(() => undefined);
          }
          await instance?.outputHistoryManager.flushPendingIndexRefresh();
          instance?.dispose();
          restoreRunState();
          if (!hadRunHistoryLocation) resetRunHistoryLocationForTests();
          removeTempDir(workspace, (dir) =>
            console.log(`  Could not clean up ${dir}`)
          );
        }
      });
    }

    test(`${harness}: headless interrupt ends the current turn quickly`, async function () {
      if (
        harness === HARNESS_IDS.ANTIGRAVITY_CLI ||
        harness === HARNESS_IDS.COPILOT_CLI ||
        harness === HARNESS_IDS.OPENCODE_CLI
      ) {
        this.skip();
      }

      const provider = IntegrationFactory.createCapabilityProvider(harness);
      if (!(await provider.checkAvailability())) {
        this.skip();
      }

      const workspace = makeHarnessWorkspaceDir(
        harness,
        `ctrlyoke-headless-interrupt-${harness}-`
      );
      const restoreRunState = isolateRunState(workspace);
      const hadRunHistoryLocation = isRunHistoryLocationInitialized();
      if (!hadRunHistoryLocation) {
        initializeRunHistoryLocation(
          configService.get("storage").runHistoryLocation
        );
      }
      let instance: WorkflowInstance | undefined;
      let execution: Promise<void> | undefined;
      let executionSettled = false;
      const dashboardMessages: unknown[] = [];

      try {
        const prompt: PromptStep = {
          name: "interruptible sleep",
          prompt: [
            "Run this exact command in the foreground and wait for it to finish before replying:",
            "node -e \"require('fs').writeFileSync('headless-interrupt-ready.txt','ready');setTimeout(()=>console.log('SLEEP_FINISHED'),25000)\"",
            "Then reply with only DONE.",
          ].join("\n"),
        };
        const workflow: PromptFile = {
          name: `headless interrupt ${harness}`,
          harness,
          model: HARNESS_MODELS[harness],
          executionMode: EXECUTION_MODES.HEADLESS,
          resumeSession: false,
          toolPermissions: {
            mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
          },
          steps: [prompt],
        };
        const workflowFile = path.join(
          workspace,
          `headless-interrupt-${harness}.ctrlyoke.json`
        );
        await fs.promises.writeFile(
          workflowFile,
          JSON.stringify(workflow, null, 2),
          "utf8"
        );

        const platform = new MockPlatform(workspace);
        const integrationFactory = new SteeringIntegrationFactory(platform);
        const detector = new MockHarnessIntegration(undefined, false);
        instance = new WorkflowInstance(
          platform,
          new PostMessageDashboardSink((message) =>
            dashboardMessages.push(message)
          ),
          integrationFactory,
          () => detector,
          () => {},
          () => {},
          workspace
        );

        assert.strictEqual(await instance.loadPromptFile(workflowFile), true);
        execution = instance
          .executeLoadedPromptFile()
          .finally(() => (executionSettled = true));

        const controlSessionId = await waitFor(
          () => integrationFactory.integration?.getHeadlessControlSessionId(),
          `${harness} headless interrupt channel`
        );
        await waitFor(
          () =>
            fs.existsSync(path.join(workspace, "headless-interrupt-ready.txt"))
              ? true
              : undefined,
          `${harness} interruptible sleep`
        );

        const interruptStartedAt = Date.now();
        await instance.interruptHeadlessTurn(controlSessionId);
        await execution;
        const interruptElapsedMs = Date.now() - interruptStartedAt;

        assert.ok(
          interruptElapsedMs < 15_000,
          `${harness}: interrupted turn took ${interruptElapsedMs}ms instead of stopping the 25-second command`
        );
        assert.strictEqual(
          instance.promptQueue.getState().status,
          EXECUTION_STATES.COMPLETED,
          `${harness}: interrupt did not complete the workflow`
        );
        assert.strictEqual(
          instance.promptQueue.getState().results[0]?.status,
          STEP_STATUS.COMPLETED,
          `${harness}: interrupted step did not complete with its partial output`
        );
      } finally {
        if (execution && instance && !executionSettled) {
          await instance.stop();
          await execution.catch(() => undefined);
        }
        await instance?.outputHistoryManager.flushPendingIndexRefresh();
        instance?.dispose();
        restoreRunState();
        if (!hadRunHistoryLocation) resetRunHistoryLocationForTests();
        removeTempDir(workspace, (dir) =>
          console.log(`  Could not clean up ${dir}`)
        );
      }
    });
  }

  for (const scenario of ["allow", "deny", "timeout"] as const) {
    test(`opencode-cli: headless approval ${scenario}`, async function () {
      const provider = IntegrationFactory.createCapabilityProvider(
        HARNESS_IDS.OPENCODE_CLI
      );
      if (!(await provider.checkAvailability())) {
        this.skip();
      }
      const version = await provider.getVersion?.();
      if (
        !version ||
        !versionSatisfies(version, `>=${OPENCODE_HEADLESS_CONTROL_MIN_VERSION}`)
      ) {
        this.skip();
      }

      await runOpenCodeApprovalCase(
        scenario,
        scenario === "allow" ? 32_000 : 0
      );
    });
  }
});
