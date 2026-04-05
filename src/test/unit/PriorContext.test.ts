import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HarnessIntegration,
  HarnessStatus,
} from "../../flightpath/HarnessIntegration";
import {
  PromptStep,
  PromptFile,
  PriorContext,
  Harness,
} from "../../types/FlightPathTypes";
import { PropertyResolver } from "../../utils/PropertyResolver";

// ---------------------------------------------------------------------------
// Test subclass that exposes the private prior-context helpers
// ---------------------------------------------------------------------------

class TestHarness extends HarnessIntegration {
  async initialize(): Promise<void> {}

  async sendPrompt(): Promise<boolean> {
    return true;
  }

  getStatus() {
    return { available: true, message: "ready", strategy: "test" };
  }

  isIntegrationAvailable(): boolean {
    return true;
  }

  getIntegrationMode(): string {
    return Harness.CopilotCli;
  }

  getInitializationStatus(): HarnessStatus {
    return HarnessStatus.Ready;
  }

  isReady(): boolean {
    return true;
  }

  protected async cancelImplementation(): Promise<void> {}

  // Expose private methods for testing
  public exposeGather(
    priorContext: PriorContext,
    allPrompts: PromptStep[],
    currentIndex: number,
    finalPromptResponseTexts: string[] = []
  ) {
    return (this as any).gatherPriorContextItems(
      priorContext,
      allPrompts,
      currentIndex,
      finalPromptResponseTexts
    );
  }

  public exposeInsert(
    promptText: string,
    contextItems: {
      index: number;
      name?: string;
      prompt?: string;
      text: string;
      type?: "finalPrompt";
    }[]
  ) {
    if (contextItems.length === 0) {
      return promptText;
    }
    const xml = (this as any).buildPriorContextXml(contextItems);
    return `${xml}\n\n${promptText}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrompt(
  text: string,
  responseText?: string,
  name?: string
): PromptStep {
  const p: PromptStep = { prompt: text };
  if (name) {
    p.name = name;
  }
  if (responseText !== undefined) {
    p._runtime = { startedAt: 0, responseText };
  }
  return p;
}

// ---------------------------------------------------------------------------
// gatherPriorContextItems
// ---------------------------------------------------------------------------

suite("gatherPriorContextItems", () => {
  let harness: TestHarness;

  setup(() => {
    harness = new TestHarness(undefined, false);
  });

  test("returns [] for 'none'", () => {
    const prompts = [makePrompt("p1", "response 1")];
    const items = harness.exposeGather("none", prompts, 1);
    assert.deepStrictEqual(items, []);
  });

  test("returns [] for 'all' when currentIndex is 0 (no prior prompts)", () => {
    const prompts = [makePrompt("p1")];
    const items = harness.exposeGather("all", prompts, 0);
    assert.deepStrictEqual(items, []);
  });

  test("returns all prior prompts for 'all'", () => {
    const prompts = [
      makePrompt("p1", "r1", "Step 1"),
      makePrompt("p2", "r2", "Step 2"),
      makePrompt("p3"),
    ];
    const items = harness.exposeGather("all", prompts, 2);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].index, 0);
    assert.strictEqual(items[0].text, "r1");
    assert.strictEqual(items[0].name, "Step 1");
    assert.strictEqual(items[0].prompt, "p1");
    assert.strictEqual(items[1].index, 1);
    assert.strictEqual(items[1].text, "r2");
    assert.strictEqual(items[1].prompt, "p2");
  });

  test("filters prompts with no responseText for 'all'", () => {
    const prompts = [
      makePrompt("p1"), // no responseText
      makePrompt("p2", "r2"),
      makePrompt("p3"),
    ];
    const items = harness.exposeGather("all", prompts, 2);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].index, 1);
    assert.strictEqual(items[0].text, "r2");
  });

  test("returns only immediately preceding for 'previous'", () => {
    const prompts = [
      makePrompt("p1", "r1"),
      makePrompt("p2", "r2"),
      makePrompt("p3"),
    ];
    const items = harness.exposeGather("previous", prompts, 2);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].index, 1);
    assert.strictEqual(items[0].text, "r2");
  });

  test("returns [] for 'previous' on prompt index 0", () => {
    const prompts = [makePrompt("p1", "r1")];
    const items = harness.exposeGather("previous", prompts, 0);
    assert.deepStrictEqual(items, []);
  });

  test("returns specified indices for array form [1, 3] (1-based)", () => {
    const prompts = [
      makePrompt("p1", "r1"),
      makePrompt("p2", "r2"),
      makePrompt("p3", "r3"),
      makePrompt("p4"),
    ];
    // Prompt 4 (index 3) uses priorContext: [1, 3]
    const items = harness.exposeGather([1, 3], prompts, 3);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].index, 0);
    assert.strictEqual(items[0].text, "r1");
    assert.strictEqual(items[1].index, 2);
    assert.strictEqual(items[1].text, "r3");
  });

  test("silently filters out-of-range indices in array form", () => {
    const prompts = [makePrompt("p1", "r1"), makePrompt("p2")];
    // Prompt 2 (index 1) specifies [1, 5] — only 1 is valid
    const items = harness.exposeGather([1, 5], prompts, 1);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].index, 0);
    assert.strictEqual(items[0].text, "r1");
  });

  test("filters prompts with empty responseText", () => {
    const prompts = [
      makePrompt("p1", ""),
      makePrompt("p2", "r2"),
      makePrompt("p3"),
    ];
    const items = harness.exposeGather("all", prompts, 2);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].index, 1);
  });

  test("self-reference filtered out (prompt cannot reference itself)", () => {
    const prompts = [makePrompt("p1", "r1"), makePrompt("p2", "r2")];
    // Prompt 2 (index 1) specifies [2] — 2 maps to index 1 = current, excluded
    const items = harness.exposeGather([2], prompts, 1);
    assert.deepStrictEqual(items, []);
  });

  // --- finalPromptAll ---

  test("'finalPromptAll' returns all finalPrompt loop responses", () => {
    const prompts: PromptStep[] = [];
    const fpTexts = ["loop 0 output", "loop 1 output", "loop 2 output"];
    const items = harness.exposeGather("finalPromptAll", prompts, 0, fpTexts);
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].index, 0);
    assert.strictEqual(items[0].text, "loop 0 output");
    assert.strictEqual(items[0].type, "finalPrompt");
    assert.strictEqual(items[2].index, 2);
    assert.strictEqual(items[2].text, "loop 2 output");
  });

  test("'finalPromptAll' returns [] when no loops have run", () => {
    const items = harness.exposeGather("finalPromptAll", [], 0, []);
    assert.deepStrictEqual(items, []);
  });

  test("'finalPromptAll' filters empty loop responses", () => {
    const fpTexts = ["loop 0 output", "", "loop 2 output"];
    const items = harness.exposeGather("finalPromptAll", [], 0, fpTexts);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].index, 0);
    assert.strictEqual(items[1].index, 2);
  });

  // --- finalPromptPrevious ---

  test("'finalPromptPrevious' returns only the last loop response", () => {
    const fpTexts = ["loop 0 output", "loop 1 output"];
    const items = harness.exposeGather("finalPromptPrevious", [], 0, fpTexts);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].index, 1);
    assert.strictEqual(items[0].text, "loop 1 output");
    assert.strictEqual(items[0].type, "finalPrompt");
  });

  test("'finalPromptPrevious' returns [] when no loops have run", () => {
    const items = harness.exposeGather("finalPromptPrevious", [], 0, []);
    assert.deepStrictEqual(items, []);
  });

  test("'finalPromptPrevious' works on queue prompts (returns last finalPrompt loop)", () => {
    const prompts = [makePrompt("p1", "r1"), makePrompt("p2")];
    const fpTexts = ["orchestrator decided X"];
    const items = harness.exposeGather(
      "finalPromptPrevious",
      prompts,
      1,
      fpTexts
    );
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, "orchestrator decided X");
    assert.strictEqual(items[0].type, "finalPrompt");
  });
});

// ---------------------------------------------------------------------------
// insertPriorContext
// ---------------------------------------------------------------------------

suite("insertPriorContext", () => {
  let harness: TestHarness;

  setup(() => {
    harness = new TestHarness(undefined, false);
  });

  test("returns promptText unchanged when contextItems is empty", () => {
    const result = harness.exposeInsert("Do the task.", []);
    assert.strictEqual(result, "Do the task.");
  });

  test("prepends <priorContext> block with correct XML structure (single step)", () => {
    const items = [{ index: 0, name: "Analyze", text: "Finding A" }];
    const result = harness.exposeInsert("Implement fixes.", items);
    assert.ok(result.startsWith("<priorContext>"));
    assert.ok(result.includes('<step index="1" name="Analyze">'));
    assert.ok(result.includes("<response>\nFinding A\n</response>"));
    assert.ok(result.endsWith("Implement fixes."));
    assert.ok(result.includes("</priorContext>\n\nImplement fixes."));
  });

  test("includes multiple steps with correct 1-based indices", () => {
    const items = [
      { index: 0, text: "result 1" },
      { index: 2, text: "result 3" },
    ];
    const result = harness.exposeInsert("Do more work.", items);
    assert.ok(result.includes('<step index="1">'));
    assert.ok(result.includes('<step index="3">'));
    assert.ok(result.endsWith("Do more work."));
  });

  test("omits name attribute when prompt has no name", () => {
    const items = [{ index: 0, text: "result" }];
    const result = harness.exposeInsert("Task.", items);
    assert.ok(result.includes('<step index="1">'));
    assert.ok(!result.includes("name="));
  });

  test("includes name attribute when prompt has a name", () => {
    const items = [{ index: 1, name: "Design Phase", text: "plan" }];
    const result = harness.exposeInsert("Task.", items);
    assert.ok(result.includes('name="Design Phase"'));
  });

  test("trims whitespace from context text", () => {
    const items = [{ index: 0, text: "  trimmed response  " }];
    const result = harness.exposeInsert("Task.", items);
    assert.ok(result.includes("<response>\ntrimmed response\n</response>"));
    assert.ok(!result.includes("  trimmed response  "));
  });

  test("adds type='finalPrompt' attribute for finalPrompt loop items", () => {
    const items = [
      { index: 0, text: "orchestrator output", type: "finalPrompt" as const },
    ];
    const result = harness.exposeInsert("Do work.", items);
    assert.ok(result.includes('type="finalPrompt"'));
    assert.ok(result.includes('<step index="1" type="finalPrompt">'));
    assert.ok(result.includes("<response>\norchestrator output\n</response>"));
  });

  test("omits type attribute for regular queue prompt items", () => {
    const items = [{ index: 0, name: "Step 1", text: "queue output" }];
    const result = harness.exposeInsert("Do work.", items);
    assert.ok(!result.includes("type="));
    assert.ok(result.includes('<step index="1" name="Step 1">'));
  });

  test("includes <prompt> tag when prompt text is provided", () => {
    const items = [
      { index: 0, prompt: "What is the plan?", text: "The plan is X" },
    ];
    const result = harness.exposeInsert("Now execute.", items);
    assert.ok(result.includes("<prompt>\nWhat is the plan?\n</prompt>"));
    assert.ok(result.includes("<response>\nThe plan is X\n</response>"));
  });

  test("omits <prompt> tag when no prompt text is provided", () => {
    const items = [{ index: 0, text: "response only" }];
    const result = harness.exposeInsert("Task.", items);
    assert.ok(!result.includes("<prompt>"));
    assert.ok(result.includes("<response>\nresponse only\n</response>"));
  });

  test("trims whitespace from prompt text", () => {
    const items = [{ index: 0, prompt: "  hello  ", text: "world" }];
    const result = harness.exposeInsert("Task.", items);
    assert.ok(result.includes("<prompt>\nhello\n</prompt>"));
    assert.ok(!result.includes("  hello  "));
  });
});

// ---------------------------------------------------------------------------
// PropertyResolver — priorContext resolution
// ---------------------------------------------------------------------------

suite("PropertyResolver priorContext", () => {
  test("uses prompt-level priorContext when specified", () => {
    const prompt: PromptStep = { prompt: "test", priorContext: "previous" };
    const workflow: PromptFile = {
      prompts: [],
      priorContext: "all", // should be ignored
    };
    const resolved = PropertyResolver.resolve(prompt, workflow);
    assert.strictEqual(resolved.priorContext, "previous");
  });

  test("falls back to workflow-level priorContext when prompt-level not specified", () => {
    const prompt: PromptStep = { prompt: "test" };
    const workflow: PromptFile = { prompts: [], priorContext: "all" };
    const resolved = PropertyResolver.resolve(prompt, workflow);
    assert.strictEqual(resolved.priorContext, "all");
  });

  test("returns undefined when neither prompt nor workflow specify priorContext", () => {
    const prompt: PromptStep = { prompt: "test" };
    const workflow: PromptFile = { prompts: [] };
    const resolved = PropertyResolver.resolve(prompt, workflow);
    assert.strictEqual(resolved.priorContext, undefined);
  });

  test("resolves array form from prompt level", () => {
    const prompt: PromptStep = { prompt: "test", priorContext: [1, 3] };
    const workflow: PromptFile = { prompts: [] };
    const resolved = PropertyResolver.resolve(prompt, workflow);
    assert.deepStrictEqual(resolved.priorContext, [1, 3]);
  });

  test("prompt 'none' overrides workflow 'all'", () => {
    const prompt: PromptStep = { prompt: "test", priorContext: "none" };
    const workflow: PromptFile = { prompts: [], priorContext: "all" };
    const resolved = PropertyResolver.resolve(prompt, workflow);
    assert.strictEqual(resolved.priorContext, "none");
  });
});
