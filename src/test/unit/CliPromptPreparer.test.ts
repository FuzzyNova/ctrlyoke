import * as assert from "assert";
import { suite, test } from "mocha";
import { CliPromptPreparer } from "../../flightpath/harness/shared/CliPromptPreparer";
import type { PromptSections } from "../../flightpath/HarnessIntegration";
import type { PromptItem } from "../../types/FlightPathTypes";
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
      buildPriorContextXml: () => "",
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
      logDebug: () => {},
      logInfo: () => {},
    });

    const result = await preparer.preparePrompt(
      { prompt: "just say hi" } as PromptItem,
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
        _prompt: PromptItem,
        agent?: string,
        skills?: string[]
      ) => {
        capturedAgent = agent;
        capturedSkills = skills;
        return createSections();
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXml: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
      logDebug: () => {},
      logInfo: () => {},
    });

    await preparer.preparePrompt(
      { prompt: "resume" } as PromptItem,
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
      buildPriorContextXml: () =>
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
      logDebug: () => {},
      logInfo: () => {},
    });

    const result = await preparer.preparePrompt(
      { prompt: "please inspect files" } as PromptItem,
      {
        workflowName: "test-workflow",
        promptIndex: 0,
        allPrompts: [{ prompt: "please inspect files" } as PromptItem],
      } as WorkflowContext,
      { priorContext: "allPrevious" } as any,
      undefined,
      []
    );

    assert.ok(result.tempFilePaths.length >= 2);
    assert.ok(result.promptWithInstruction.includes("@C:/repo/src/index.ts"));
    assert.ok(createdFiles.length >= 2);
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
      buildPriorContextXml: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
      logDebug: () => {},
      logInfo: () => {},
    });

    const result = await preparer.preparePrompt(
      { prompt: "/handoff" } as PromptItem,
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
      buildPriorContextXml: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
      logDebug: () => {},
      logInfo: () => {},
    });

    const result = await preparer.preparePrompt(
      { prompt: "/handoff summarize the session" } as PromptItem,
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
      buildPriorContextXml: () => "",
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
      logDebug: () => {},
      logInfo: () => {},
    });

    const result = await preparer.preparePrompt(
      { prompt: "/handoff inspect repo state" } as PromptItem,
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
