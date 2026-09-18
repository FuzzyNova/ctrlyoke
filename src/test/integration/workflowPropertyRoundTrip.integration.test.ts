import { suite, test, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  MESSAGE_TYPES,
  SESSION_ID_SENTINELS,
} from "../../types/DashboardConstants";
import {
  createPromotedRun,
  createRoundTripHarness,
  type RoundTripHarness,
} from "./helpers/propertyRoundTrip";

/**
 * Message-contract round trip for WorkflowPropertiesPanel edits:
 * a workflow-level property posted as the panel posts it must land on the
 * addressed promoted run's `workflow.ctrlyoke.json`. The sentinel cases
 * (explicit-clear "" / explicit-disable null / delete) are where "set in the
 * UI but runs with the default" regressions hide.
 */
suite("Workflow property round trip (panel -> working file)", () => {
  let workspace: string;

  async function harness(steps = [{ prompt: "step 1" }]): Promise<{
    h: RoundTripHarness;
  }> {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-wf-prop-"));
    const run = await createPromotedRun(workspace, { steps });
    return { h: createRoundTripHarness(workspace, run) };
  }

  teardown(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
      workspace = "";
    }
  });

  test("canary: model lands on the run definition head", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("model", "claude-opus-4-8");
    const def = await h.readRunDefinition();
    assert.strictEqual(def.model, "claude-opus-4-8");
  });

  test("executionMode survives the workflow property round trip", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("executionMode", "headless");
    assert.strictEqual((await h.readRunDefinition()).executionMode, "headless");
  });

  test("step and workflow executionMode survive a fresh definition reload", async () => {
    const { h } = await harness([{ prompt: "step 1" }, { prompt: "step 2" }]);
    await h.routeWorkflowPropertyUpdate("executionMode", "interactive");
    await h.routeUpdatePrompt({
      index: 1,
      text: "step 2",
      properties: { executionMode: "headless" },
    });

    const reloaded = await h.readRunDefinition();
    assert.strictEqual(reloaded.executionMode, "interactive");
    assert.strictEqual(reloaded.steps?.[1].executionMode, "headless");
  });

  test("each definition write bumps definitionRevision", async () => {
    const { h } = await harness();
    const before = (await h.readRunDefinition()).definitionRevision ?? 1;
    await h.routeWorkflowPropertyUpdate("model", "claude-sonnet-5");
    const after = (await h.readRunDefinition()).definitionRevision ?? 1;
    assert.strictEqual(after, before + 1);
  });

  test("agent explicit-None ('') persists as schema-valid null", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("agent", "reviewer.agent.md");
    assert.strictEqual(
      (await h.readRunDefinition()).agent,
      "reviewer.agent.md"
    );
    await h.routeWorkflowPropertyUpdate("agent", "");
    const def = await h.readRunDefinition();
    assert.ok("agent" in def, "agent key must remain to encode explicit None");
    assert.strictEqual(def.agent, null);
  });

  test("skills explicit-None ([]) survives as an empty array", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("skills", ["debugging"]);
    assert.deepStrictEqual((await h.readRunDefinition()).skills, ["debugging"]);
    await h.routeWorkflowPropertyUpdate("skills", []);
    assert.deepStrictEqual((await h.readRunDefinition()).skills, []);
  });

  test("mcpServers None (null) persists as an explicit disable", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("mcpServers", ["ctrlyoke"]);
    assert.deepStrictEqual((await h.readRunDefinition()).mcpServers, [
      "ctrlyoke",
    ]);
    await h.routeWorkflowPropertyUpdate("mcpServers", null);
    const def = await h.readRunDefinition();
    assert.ok("mcpServers" in def);
    assert.strictEqual(def.mcpServers, null);
  });

  test("endCondition object then null-disable round trip", async () => {
    const { h } = await harness();
    const endCondition = { script: "npm test", expected: "true" };
    await h.routeWorkflowPropertyUpdate("endCondition", endCondition);
    assert.deepStrictEqual(
      (await h.readRunDefinition()).endCondition,
      endCondition
    );
    await h.routeWorkflowPropertyUpdate("endCondition", null);
    const def = await h.readRunDefinition();
    assert.strictEqual(def.endCondition, null);
  });

  test("additionalArgs cleared to '' persists an explicit clear", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("additionalArgs", "--effort high");
    assert.strictEqual(
      (await h.readRunDefinition()).additionalArgs,
      "--effort high"
    );
    await h.routeWorkflowPropertyUpdate("additionalArgs", "");
    const def = await h.readRunDefinition();
    assert.ok("additionalArgs" in def);
    assert.strictEqual(def.additionalArgs, "");
  });

  test("toolPermissions nested object round trip", async () => {
    const { h } = await harness();
    const toolPermissions = {
      mode: "custom",
      allowedTools: ["read", "grep"],
      deniedTools: ["shell(rm:*)"],
    };
    await h.routeWorkflowPropertyUpdate("toolPermissions", toolPermissions);
    assert.deepStrictEqual(
      (await h.readRunDefinition()).toolPermissions,
      toolPermissions
    );
  });

  test("errorBehavior retry config round trip", async () => {
    const { h } = await harness();
    const errorBehavior = { onError: "retry", maxRetries: 3 };
    await h.routeWorkflowPropertyUpdate("errorBehavior", errorBehavior);
    assert.deepStrictEqual(
      (await h.readRunDefinition()).errorBehavior,
      errorBehavior
    );
  });

  test("resumeSession + Final Step Session sentinel round trip (panel pairing)", async () => {
    const { h } = await harness();
    // handleResumeSessionChange posts both keys together for Final Step Session.
    await h.routeWorkflowPropertiesUpdate({
      resumeSession: true,
      sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
    });
    const def = await h.readRunDefinition();
    assert.strictEqual(def.resumeSession, true);
    assert.strictEqual(def.sessionId, SESSION_ID_SENTINELS.FINAL_STEP);
  });

  test("sessionId numeric prompt reference persists as a number", async () => {
    const { h } = await harness();
    // handleSessionIdChange parses digit-only input to an integer.
    await h.routeWorkflowPropertyUpdate("sessionId", 2);
    assert.strictEqual((await h.readRunDefinition()).sessionId, 2);
  });

  test("blank sessionId (undefined over the wire) removes the key", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("sessionId", 3);
    assert.strictEqual((await h.readRunDefinition()).sessionId, 3);
    // handleSessionIdChange sends `value.trim() || undefined` for blank input;
    // undefined does not survive the wire as a value, so the extension sees a
    // delete instruction.
    await h.routeWorkflowPropertyUpdate("sessionId", undefined);
    assert.ok(!("sessionId" in (await h.readRunDefinition())));
  });

  test("hooks array of objects round trip and null-disable", async () => {
    const { h } = await harness();
    const hooks = [
      { event: "PreToolUse", command: "echo pre", matcher: "shell" },
    ];
    await h.routeWorkflowPropertyUpdate("hooks", hooks);
    assert.deepStrictEqual((await h.readRunDefinition()).hooks, hooks);
    await h.routeWorkflowPropertyUpdate("hooks", null);
    const def = await h.readRunDefinition();
    assert.ok("hooks" in def);
    assert.strictEqual(def.hooks, null);
  });

  test("priorContext keyword and custom number[] shapes both persist", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("priorContext", "all");
    assert.strictEqual((await h.readRunDefinition()).priorContext, "all");
    await h.routeWorkflowPropertyUpdate("priorContext", [1, 3]);
    assert.deepStrictEqual((await h.readRunDefinition()).priorContext, [1, 3]);
  });

  test("preCondition object then null-disable round trip", async () => {
    const { h } = await harness();
    const preCondition = { script: "git diff --quiet", onFail: "skipPrompt" };
    await h.routeWorkflowPropertyUpdate("preCondition", preCondition);
    assert.deepStrictEqual(
      (await h.readRunDefinition()).preCondition,
      preCondition
    );
    await h.routeWorkflowPropertyUpdate("preCondition", null);
    assert.strictEqual((await h.readRunDefinition()).preCondition, null);
  });

  test("batched UPDATE_WORKFLOW_PROPERTIES applies all keys in one revision bump", async () => {
    const { h } = await harness();
    const before = (await h.readRunDefinition()).definitionRevision ?? 1;
    await h.routeWorkflowPropertiesUpdate({
      harness: "claude-cli",
      model: "claude-opus-4-8",
      additionalArgs: "--max-turns 10",
    });
    const def = await h.readRunDefinition();
    assert.strictEqual(def.harness, "claude-cli");
    assert.strictEqual(def.model, "claude-opus-4-8");
    assert.strictEqual(def.additionalArgs, "--max-turns 10");
    assert.strictEqual(def.definitionRevision, before + 1);
  });

  test("setting a property to undefined deletes the key (allowDeletes)", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("model", "claude-sonnet-5");
    assert.ok("model" in (await h.readRunDefinition()));
    await h.routeWorkflowPropertyUpdate("model", undefined);
    const def = await h.readRunDefinition();
    assert.ok(
      !("model" in def),
      "undefined must remove the key, not store null"
    );
  });

  test("the settings-sync republish echoes the written properties back to the client", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("model", "claude-opus-4-8");
    const echo = h.sentMessages.find(
      (m) => m.type === MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE
    );
    assert.ok(echo, "expected a WORKFLOW_PROPERTIES_UPDATE echo");
    assert.strictEqual(
      (echo.workflowProperties as Record<string, unknown>).model,
      "claude-opus-4-8"
    );
  });

  test("a stale definition revision is rejected and the file is unchanged", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("model", "claude-opus-4-8");
    const stale = await h.staleMutationContext();
    await h.advanceRunDefinitionRevisionExternally();
    const before = await h.readRunDefinition();

    await assert.rejects(
      () => h.routeWorkflowPropertyUpdateWith(stale, "model", "codex"),
      /revision conflict/i
    );

    const after = await h.readRunDefinition();
    assert.deepStrictEqual(
      after,
      before,
      "rejected write must not mutate disk"
    );
  });
});
