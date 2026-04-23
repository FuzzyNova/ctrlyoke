import * as assert from "assert";
import { suite, test } from "mocha";
import { CliPromptPreparer } from "../../flightpath/harness/shared/CliPromptPreparer";
import type { PromptSections } from "../../flightpath/HarnessIntegration";
import type { PromptStep } from "../../types/FlightPathTypes";
import type { WorkflowContext } from "../../types/WorkflowContextTypes";

function createSections(overrides?: Partial<PromptSections>): PromptSections {
  return {
    skillContent: null,
    agentContent: null,
    directFileRefs: [],
    excerptContent: null,
    userPromptText: "just say hi",
    ...overrides,
  };
}

suite("CliPromptPreparer", () => {
  test("should use fast path for simple prompts with no extras", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () => createSections(),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      gatherAndMergeContextItems: () => [],
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => {
        throw new Error("should not format direct refs on fast path");
      },
      formatTempFileRef: () => {
        throw new Error("should not format temp refs on fast path");
      },
      formatCategorizedReferences: () => {
        throw new Error("should not build categorized refs on fast path");
      },
    });

    const result = await preparer.preparePrompt(
      { prompt: "just say hi" } as PromptStep,
      undefined,
      undefined,
      undefined
    );

    assert.deepStrictEqual(result, {
      promptWithInstruction: "just say hi",
      tempFilePaths: [],
    });
  });

  test("should omit agent and skills on resume when configured", async () => {
    let capturedAgent: string | undefined;
    let capturedSkills: string[] | undefined;

    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => true,
      buildPromptSections: async (
        _prompt: PromptStep,
        agent?: string,
        skills?: string[]
      ) => {
        capturedAgent = agent;
        capturedSkills = skills;
        return createSections();
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      gatherAndMergeContextItems: () => [],
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    await preparer.preparePrompt(
      { prompt: "resume" } as PromptStep,
      undefined,
      { agent: "reviewer", skills: ["git", "testing"] } as any,
      "existing-session"
    );

    assert.strictEqual(capturedAgent, undefined);
    assert.deepStrictEqual(capturedSkills, undefined);
  });

  test("should create categorized files when extras exist", async () => {
    const createdFiles: string[] = [];
    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["C:/repo/src/index.ts"],
          userPromptText: "please inspect files",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => false,
      gatherAndMergeContextItems: () => [{ index: 0, text: "hello" }],
      buildPriorContextXmlFromItems: () =>
        "<priorContext><step>hello</step></priorContext>",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath: string) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath: string) => {
        createdFiles.push(absolutePath);
        return `@${absolutePath}`;
      },
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        directRefs,
        contextRefs,
        _excerptRefs,
        promptRefs
      ) => [...directRefs, ...contextRefs, ...promptRefs].join(" | "),
    });

    const result = await preparer.preparePrompt(
      { prompt: "please inspect files" } as PromptStep,
      {
        workflowName: "test-workflow",
        promptIndex: 0,
        allPrompts: [{ prompt: "please inspect files" } as PromptStep],
      } as WorkflowContext,
      { priorContext: "allPrevious" } as any,
      undefined,
      []
    );

    assert.ok(result.tempFilePaths.length >= 2);
    assert.ok(result.promptWithInstruction.includes("@C:/repo/src/index.ts"));
    assert.ok(createdFiles.length >= 2);
  });

  test("should create one prior-context file for inline refs", async () => {
    let capturedInlineRefCount = 0;
    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ userPromptText: "use $previous and continue" }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      gatherAndMergeContextItems: (_propertyContext, inlineRefs) => {
        capturedInlineRefCount = inlineRefs.length;
        return [{ index: 0, text: "prior output" }];
      },
      buildPriorContextXmlFromItems: () =>
        "<priorContext><step>prior output</step></priorContext>",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: (_tempMgr, absolutePath: string) => `@${absolutePath}`,
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        _directRefs,
        contextRefs,
        _excerptRefs,
        promptRefs
      ) => [...contextRefs, ...promptRefs].join(" | "),
    });

    const result = await preparer.preparePrompt(
      { prompt: "use $previous and continue" } as PromptStep,
      {
        workflowName: "test-workflow",
        promptIndex: 1,
        allPrompts: [
          { prompt: "first" } as PromptStep,
          { prompt: "use $previous and continue" } as PromptStep,
        ],
      } as WorkflowContext,
      undefined,
      undefined
    );

    assert.strictEqual(capturedInlineRefCount, 1);
    assert.ok(
      result.tempFilePaths.some((filePath) =>
        filePath.endsWith(".context.md")
      )
    );
  });

  test("should use fast path when only file refs exist and text-minus-refs is simple", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["/workspace/Path/To/Plan.md"],
          userPromptText: "fully implement @Path/To/Plan.md",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: (text) => text === "fully implement",
      gatherAndMergeContextItems: () => [],
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => {
        throw new Error("should not format refs on fast path");
      },
      formatTempFileRef: () => {
        throw new Error("should not format refs on fast path");
      },
      formatCategorizedReferences: () => {
        throw new Error("should not build categorized refs on fast path");
      },
    });

    const result = await preparer.preparePrompt(
      { prompt: "fully implement @Path/To/Plan.md" } as PromptStep,
      undefined,
      undefined,
      undefined
    );

    assert.deepStrictEqual(result, {
      promptWithInstruction: "fully implement @Path/To/Plan.md",
      tempFilePaths: [],
    });
  });

  test("should keep pure slash commands inline and skip prompt assembly", async () => {
    let buildSectionsCalled = false;

    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () => {
        buildSectionsCalled = true;
        return createSections();
      },
      extractLeadingSlashCommand: () => "/handoff",
      isSimplePrompt: () => true,
      gatherAndMergeContextItems: () => [],
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    const result = await preparer.preparePrompt(
      { prompt: "/handoff" } as PromptStep,
      undefined,
      undefined,
      undefined
    );

    assert.deepStrictEqual(result, {
      promptWithInstruction: "/handoff",
      tempFilePaths: [],
    });
    assert.strictEqual(buildSectionsCalled, false);
  });

  test("should not duplicate slash command prefixes on inline simple prompts", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ userPromptText: "/handoff summarize the session" }),
      extractLeadingSlashCommand: () => "/handoff",
      isSimplePrompt: () => true,
      gatherAndMergeContextItems: () => [],
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    const result = await preparer.preparePrompt(
      { prompt: "/handoff summarize the session" } as PromptStep,
      undefined,
      undefined,
      undefined
    );

    assert.deepStrictEqual(result, {
      promptWithInstruction: "/handoff summarize the session",
      tempFilePaths: [],
    });
  });

  test("should prepend slash commands to categorized instructions once", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["C:/repo/src/index.ts"],
          userPromptText: "/handoff inspect repo state",
        }),
      extractLeadingSlashCommand: () => "/handoff",
      isSimplePrompt: () => false,
      gatherAndMergeContextItems: () => [],
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath: string) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath: string) => `@${absolutePath}`,
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        directRefs,
        _contextRefs,
        _excerptRefs,
        promptRefs
      ) => [...directRefs, ...promptRefs].join(" | "),
    });

    const result = await preparer.preparePrompt(
      { prompt: "/handoff inspect repo state" } as PromptStep,
      undefined,
      undefined,
      undefined
    );

    assert.ok(
      result.promptWithInstruction.startsWith(
        "/handoff @C:/repo/src/index.ts | @"
      )
    );
    assert.strictEqual(
      result.promptWithInstruction.includes("/handoff /handoff"),
      false
    );
  });
});
