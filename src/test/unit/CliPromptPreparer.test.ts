import * as assert from "assert";
import { suite, test } from "mocha";
import { CliPromptPreparer } from "../../core/harness/shared/CliPromptPreparer";
import type { PromptSections } from "../../core/HarnessIntegration";
import type { PromptStep } from "../../types/CtrlYokeTypes";
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
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () => createSections(),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
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

  test("should keep attaching agents and skills that were not previously attached on resume", async () => {
    let capturedAgent: string | undefined;
    let capturedSkills: string[] | undefined;

    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => true,
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
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    await preparer.preparePrompt(
      { prompt: "resume" } as PromptStep,
      {
        promptIndex: 1,
        allPrompts: [
          {
            prompt: "start",
            _runtime: {
              startedAt: 1,
              completedAt: 2,
              sessionId: "existing-session",
              harness: "codex-cli",
            },
          } as PromptStep,
          { prompt: "resume" } as PromptStep,
        ],
      } as WorkflowContext,
      {
        harness: "codex-cli",
        agent: "reviewer",
        skills: ["git", "testing"],
      } as any,
      "existing-session"
    );

    assert.strictEqual(capturedAgent, "reviewer");
    assert.deepStrictEqual(capturedSkills, ["git", "testing"]);
  });

  test("should attach only newly added skills on resume when previous attachments overlap", async () => {
    let capturedAgent: string | undefined;
    let capturedSkills: string[] | undefined;

    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => true,
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
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    await preparer.preparePrompt(
      { prompt: "resume" } as PromptStep,
      {
        promptIndex: 1,
        allPrompts: [
          {
            prompt: "start",
            _runtime: {
              startedAt: 1,
              completedAt: 2,
              sessionId: "existing-session",
              harness: "codex-cli",
              agent: "reviewer",
              skills: ["git"],
            },
          } as PromptStep,
          { prompt: "resume" } as PromptStep,
        ],
      } as WorkflowContext,
      {
        harness: "codex-cli",
        agent: "reviewer",
        skills: ["git", "testing"],
      } as any,
      "existing-session"
    );

    assert.strictEqual(capturedAgent, undefined);
    assert.deepStrictEqual(capturedSkills, ["testing"]);
  });

  test("should create categorized files when extras exist", async () => {
    const createdFiles: string[] = [];
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["C:/repo/src/index.ts"],
          userPromptText: "please inspect files",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => false,
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
        resolvePriorContextItems: async () => [{ index: 0, text: "hello" }],
      } as WorkflowContext,
      { priorContext: "allPrevious" } as any,
      undefined
    );

    assert.ok(result.tempFilePaths.length >= 2);
    assert.ok(result.promptWithInstruction.includes("@C:/repo/src/index.ts"));
    assert.ok(createdFiles.length >= 2);
  });

  test("should create one prior-context file for inline refs", async () => {
    let capturedInlineRefCount = 0;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ userPromptText: "use $previous and continue" }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
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
        resolvePriorContextItems: async (contexts) => {
          capturedInlineRefCount = contexts.length;
          return [{ index: 0, text: "prior output" }];
        },
      } as WorkflowContext,
      undefined,
      undefined
    );

    assert.strictEqual(capturedInlineRefCount, 1);
    assert.ok(
      result.tempFilePaths.some((filePath) => filePath.endsWith(".context.md"))
    );
  });

  test("should use fast path when only file refs exist and full text is simple", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["/workspace/Path/To/Plan.md"],
          userPromptText: "fully implement @Path/To/Plan.md",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: (text) =>
        !text.includes('"') && !text.includes("$") && !text.includes("`"),
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
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () => {
        buildSectionsCalled = true;
        return createSections();
      },
      extractLeadingSlashCommand: () => "/handoff",
      isSimplePrompt: () => true,
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
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ userPromptText: "/handoff summarize the session" }),
      extractLeadingSlashCommand: () => "/handoff",
      isSimplePrompt: () => true,
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
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["C:/repo/src/index.ts"],
          userPromptText: "/handoff inspect repo state",
        }),
      extractLeadingSlashCommand: () => "/handoff",
      isSimplePrompt: () => false,
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

  suite("inject mode", () => {
    function makeBasePreparer(
      overrides: Partial<
        ConstructorParameters<typeof CliPromptPreparer>[0]
      > = {}
    ) {
      return new CliPromptPreparer({
        shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
        buildPromptSections: async (p) =>
          createSections({ userPromptText: p.prompt.trim() }),
        extractLeadingSlashCommand: () => null,
        isSimplePrompt: (text) => text.length <= 50,
        isInjectablePrompt: (text) => !/[\x00-\x1f\x7f]/.test(text),
        buildPriorContextXmlFromItems: () => "",
        getWorkspaceRoot: () => process.cwd(),
        getTempFileSplitConfig: () => undefined,
        formatDirectFileRef: (p) => `@${p}`,
        formatTempFileRef: (_m, p) => `@${p}`,
        formatCategorizedReferences: (...refs) => refs.flat().join(" "),
        ...overrides,
      });
    }

    test("long prompt (>simple limit) goes inline in inject mode", async () => {
      const longPrompt = "a".repeat(200);
      const preparer = makeBasePreparer();

      const result = await preparer.preparePrompt(
        { prompt: longPrompt } as PromptStep,
        undefined,
        undefined,
        undefined,
        true
      );

      assert.deepStrictEqual(result, {
        promptWithInstruction: longPrompt,
        tempFilePaths: [],
      });
    });

    test("prompt with shell-special characters goes inline in inject mode", async () => {
      const prompt = `fix the "async" error and replace \`await\` with $var`;
      const preparer = makeBasePreparer();

      const result = await preparer.preparePrompt(
        { prompt } as PromptStep,
        undefined,
        undefined,
        undefined,
        true
      );

      assert.deepStrictEqual(result, {
        promptWithInstruction: prompt,
        tempFilePaths: [],
      });
    });

    test("prompt with control characters uses file-based path even in inject mode", async () => {
      const promptWithNewline = "line one\nline two";
      let categorizedRefsCalled = false;
      const preparer = makeBasePreparer({
        buildPromptSections: async () =>
          createSections({ userPromptText: promptWithNewline }),
        formatCategorizedReferences: (..._refs) => {
          categorizedRefsCalled = true;
          return "categorized";
        },
      });

      const result = await preparer.preparePrompt(
        { prompt: promptWithNewline } as PromptStep,
        undefined,
        undefined,
        undefined,
        true
      );

      assert.ok(
        categorizedRefsCalled,
        "should fall through to file-based path"
      );
      assert.strictEqual(result.promptWithInstruction, "categorized");
    });

    test("inject mode with only file refs uses injectable check on remaining text", async () => {
      const prompt = `implement the "feature" described in @Plan.md`;
      const preparer = makeBasePreparer({
        buildPromptSections: async () =>
          createSections({
            directFileRefs: ["/ws/Plan.md"],
            userPromptText: prompt,
          }),
      });

      const result = await preparer.preparePrompt(
        { prompt } as PromptStep,
        undefined,
        undefined,
        undefined,
        true
      );

      assert.deepStrictEqual(result, {
        promptWithInstruction: prompt,
        tempFilePaths: [],
      });
    });

    test("non-inject mode still rejects shell-special characters", async () => {
      const prompt = `fix the "async" error`;
      let categorizedRefsCalled = false;
      const preparer = makeBasePreparer({
        isSimplePrompt: (text) => !/["'`$\\]/.test(text) && text.length <= 50,
        buildPromptSections: async () =>
          createSections({ userPromptText: prompt }),
        formatCategorizedReferences: () => {
          categorizedRefsCalled = true;
          return "categorized";
        },
      });

      await preparer.preparePrompt(
        { prompt } as PromptStep,
        undefined,
        undefined,
        undefined,
        false
      );

      assert.ok(
        categorizedRefsCalled,
        "shell-special chars should use file path in strict mode"
      );
    });
  });
});
