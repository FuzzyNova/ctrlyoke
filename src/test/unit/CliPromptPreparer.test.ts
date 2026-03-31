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
      isSimplePrompt: () => true,
      buildPriorContextXml: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
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
});
