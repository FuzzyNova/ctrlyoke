import { suite, test, teardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  createPromotedRun,
  createRoundTripHarness,
  type RoundTripHarness,
} from "./helpers/propertyRoundTrip";

/**
 * Message-contract round trip for PropertiesDrawer edits: a per-step override
 * committed as the prompt editor posts it (UPDATE_PROMPT with `{ index, text,
 * properties, clearProperties }`) must land on that step in the addressed run's
 * definition head — and "inherit" (clearProperties) must remove the override
 * rather than persist a stale value.
 */
suite("Prompt property round trip (drawer -> working file)", () => {
  let workspace: string;

  async function harness(): Promise<{ h: RoundTripHarness }> {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-step-prop-"));
    const run = await createPromotedRun(workspace, {
      steps: [{ prompt: "first" }, { prompt: "second" }],
    });
    return { h: createRoundTripHarness(workspace, run) };
  }

  teardown(async () => {
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true });
      workspace = "";
    }
  });

  test("canary: a per-step model override lands on that step", async () => {
    const { h } = await harness();
    await h.routeUpdatePrompt({
      index: 1,
      text: "second",
      properties: { model: "claude-opus-4-8" },
    });
    const steps = (await h.readRunDefinition()).steps ?? [];
    assert.strictEqual(steps[1].model, "claude-opus-4-8");
    // The sibling step keeps no override.
    assert.ok(!("model" in steps[0]));
  });

  test("editing the prompt text persists alongside the override", async () => {
    const { h } = await harness();
    await h.routeUpdatePrompt({
      index: 0,
      text: "rewritten first",
      properties: { agent: "reviewer.agent.md" },
    });
    const steps = (await h.readRunDefinition()).steps ?? [];
    assert.strictEqual(steps[0].prompt, "rewritten first");
    assert.strictEqual(steps[0].agent, "reviewer.agent.md");
  });

  test("agent override, inherit, and explicit null survive the full round trip", async () => {
    const { h } = await harness();
    await h.routeWorkflowPropertyUpdate("agent", "workflow-agent");
    await h.routeUpdatePrompt({
      index: 0,
      text: "first",
      properties: { agent: "prompt-agent" },
    });

    let definition = await h.readRunDefinition();
    let step = definition.steps?.[0];
    assert.ok(step && "prompt" in step);
    assert.strictEqual(step.agent, "prompt-agent");

    await h.routeUpdatePrompt({
      index: 0,
      text: "first",
      properties: {},
      clearProperties: ["agent"],
    });
    definition = await h.readRunDefinition();
    step = definition.steps?.[0];
    assert.ok(step && "prompt" in step);
    assert.ok(!("agent" in step));
    assert.strictEqual(definition.agent, "workflow-agent");

    await h.routeUpdatePrompt({
      index: 0,
      text: "first",
      properties: { agent: null },
    });
    definition = await h.readRunDefinition();
    step = definition.steps?.[0];
    assert.ok(step && "prompt" in step);
    assert.strictEqual(step.agent, null);
  });

  test("executionMode override survives save/reload and inherit clears it", async () => {
    const { h } = await harness();
    await h.routeUpdatePrompt({
      index: 1,
      text: "second",
      properties: { executionMode: "headless" },
    });
    assert.strictEqual(
      (await h.readRunDefinition()).steps?.[1].executionMode,
      "headless"
    );

    await h.routeUpdatePrompt({
      index: 1,
      text: "second",
      properties: {},
      clearProperties: ["executionMode"],
    });
    assert.strictEqual(
      "executionMode" in ((await h.readRunDefinition()).steps?.[1] ?? {}),
      false
    );
  });

  test("clearProperties removes an override (inherit) instead of persisting it", async () => {
    const { h } = await harness();
    await h.routeUpdatePrompt({
      index: 1,
      text: "second",
      properties: { model: "claude-sonnet-5" },
    });
    assert.strictEqual(
      ((await h.readRunDefinition()).steps ?? [])[1].model,
      "claude-sonnet-5"
    );

    await h.routeUpdatePrompt({
      index: 1,
      text: "second",
      properties: {},
      clearProperties: ["model"],
    });
    const step = ((await h.readRunDefinition()).steps ?? [])[1];
    assert.ok(
      !("model" in step),
      "inherit must drop the override key, not leave a stale value"
    );
  });

  test("a per-step edit bumps the run definitionRevision", async () => {
    const { h } = await harness();
    const before = (await h.readRunDefinition()).definitionRevision ?? 1;
    await h.routeUpdatePrompt({
      index: 0,
      text: "first",
      properties: { model: "codex" },
    });
    const after = (await h.readRunDefinition()).definitionRevision ?? 1;
    assert.strictEqual(after, before + 1);
  });
});
