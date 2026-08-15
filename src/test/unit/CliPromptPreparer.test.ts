import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { CliPromptPreparer } from "../../core/harness/shared/CliPromptPreparer";
import type { PromptSections } from "../../core/HarnessIntegration";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import type { WorkflowContext } from "../../types/WorkflowContextTypes";
import { encode } from "gpt-tokenizer";
import {
  ESTIMATED_CHARS_PER_TOKEN,
  MAX_CONTENT_SIZE,
  MAX_PREVIEW_BODY_BYTES,
  PREVIEW_PROMPT_CATEGORIES,
  PREVIEW_TRUNCATION_REASONS,
} from "../../types/DashboardConstants";

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

  test("should keep pure native /commit and /mcp commands inline", async () => {
    for (const command of ["/commit", "/mcp"]) {
      let buildSectionsCalled = false;
      const preparer = new CliPromptPreparer({
        shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
        buildPromptSections: async () => {
          buildSectionsCalled = true;
          return createSections();
        },
        extractLeadingSlashCommand: (text) => text,
        isSimplePrompt: () => true,
        buildPriorContextXmlFromItems: () => "",
        getWorkspaceRoot: () => process.cwd(),
        getTempFileSplitConfig: () => undefined,
        formatDirectFileRef: () => "",
        formatTempFileRef: () => "",
        formatCategorizedReferences: () => "",
      });

      const result = await preparer.preparePrompt(
        { prompt: command } as PromptStep,
        undefined,
        undefined,
        undefined
      );

      assert.deepStrictEqual(result, {
        promptWithInstruction: command,
        tempFilePaths: [],
      });
      assert.strictEqual(buildSectionsCalled, false);
    }
  });

  test("should attach and rewrite a discovered inline skill without mutating the prompt", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-inline-skill-")
    );
    const skillPath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "skills",
      "commit",
      "SKILL.md"
    );
    await fs.promises.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.promises.writeFile(skillPath, "---\ndescription: Commit changes\n---\n", "utf8");

    let capturedSkills: string[] | undefined;
    const prompt = {
      prompt: "/skill:commit",
    } as PromptStep;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (_prompt, _agent, skills) => {
        capturedSkills = skills;
        return createSections({
          skillContent: skills?.length ? "attached commit skill" : null,
          userPromptText: _prompt.prompt,
        });
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const result = await preparer.planPrompt(
        prompt,
        undefined,
        undefined,
        undefined
      );

      assert.deepStrictEqual(capturedSkills, ["commit"]);
      assert.ok(result.files.some((file) => file.content.includes("skill")));
      assert.strictEqual(
        result.files.find((file) => file.category === "prompt")?.content,
        "skill: commit"
      );
      assert.strictEqual(prompt.prompt, "/skill:commit");
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("should merge inline skills with explicit skills without duplicates", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-inline-skill-")
    );
    const skillPath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "skills",
      "commit",
      "SKILL.md"
    );
    await fs.promises.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.promises.writeFile(skillPath, "# commit", "utf8");

    let capturedSkills: string[] | undefined;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (_prompt, _agent, skills) => {
        capturedSkills = skills;
        return createSections({
          skillContent: skills?.length ? "attached skills" : null,
          userPromptText: _prompt.prompt,
        });
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const result = await preparer.planPrompt(
        { prompt: "using /skill:commit now" } as PromptStep,
        undefined,
        { skills: ["commit", "review"] } as any,
        undefined
      );

      assert.deepStrictEqual(capturedSkills, ["commit", "review"]);
      assert.strictEqual(
        result.files.find((file) => file.category === "prompt")?.content,
        "using skill: commit now"
      );
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("should rewrite resolved MCP references in place, including repeated guidance", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (_prompt) =>
        createSections({ userPromptText: _prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    const result = await preparer.planPrompt(
      {
        prompt:
          "only use /mcp:ctrlyoke if you need to add more steps, and only use /mcp:playwright if you need to test a UI",
      } as PromptStep,
      undefined,
      {
        mcpServers: [
          "ctrlyoke",
          { id: "playwright", command: "node", args: ["server.js"] },
        ],
      } as any,
      undefined
    );

    assert.strictEqual(
      result.promptWithInstruction,
      "only use mcp: ctrlyoke if you need to add more steps, and only use mcp: playwright if you need to test a UI"
    );
  });

  test("should leave an unknown MCP reference untouched", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (_prompt) =>
        createSections({ userPromptText: _prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    const result = await preparer.planPrompt(
      { prompt: "/mcp:unknown" } as PromptStep,
      undefined,
      { mcpServers: null } as any,
      undefined
    );

    assert.strictEqual(result.promptWithInstruction, "/mcp:unknown");
  });

  test("should leave an unknown inline skill and report a diagnostic", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-inline-skill-")
    );
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (_prompt) =>
        createSections({ userPromptText: _prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const result = await preparer.planPrompt(
        { prompt: "/skill:unknown" } as PromptStep,
        undefined,
        undefined,
        undefined
      );

      assert.strictEqual(result.promptWithInstruction, "/skill:unknown");
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].code, "prompt.skill.unknown");
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
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

  test("should preview an unresolved prior-context reference without creating a file or mutation", async () => {
    const tempReferences: string[] = [];
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["/workspace/Plan.md"],
          excerptContent: "<attachment>excerpt</attachment>",
          userPromptText: "summarize the plan",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => false,
      buildPriorContextXmlFromItems: () => {
        throw new Error("unresolvable context must not be serialized");
      },
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => {
        tempReferences.push(absolutePath);
        return `@${absolutePath}`;
      },
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        directRefs,
        contextRefs,
        excerptRefs,
        promptRefs
      ) =>
        [...directRefs, ...contextRefs, ...excerptRefs, ...promptRefs].join(
          " | "
        ),
    });

    const plan = await preparer.planPrompt(
      { prompt: "summarize the plan" } as PromptStep,
      {
        workflowName: "workflow",
        promptIndex: 1,
        allPrompts: [{ prompt: "summarize the plan" } as PromptStep],
        resolvePriorContextItems: async () => [],
      } as WorkflowContext,
      { priorContext: "allPrevious" } as any,
      undefined
    );

    const priorSections = plan.promptPreview.sections.filter(
      (section) =>
        section.category === PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT
    );
    assert.strictEqual(priorSections.length, 1);
    assert.deepStrictEqual(priorSections[0], {
      category: PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT,
      byteCount: 0,
      tokenEstimate: 0,
      chunkIndex: 0,
      lineCount: null,
      contentHash: null,
      truncationReason: PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE,
    });
    assert.deepStrictEqual(
      plan.promptPreview.sections.map((section) => section.category),
      [
        PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE,
        PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT,
        PREVIEW_PROMPT_CATEGORIES.INLINE_REFERENCE,
        PREVIEW_PROMPT_CATEGORIES.PROMPT_TEXT,
      ]
    );
    assert.strictEqual(
      tempReferences.some((filePath) => filePath.endsWith(".context.md")),
      false
    );
    assert.strictEqual(
      plan.mutations.some((mutation) => mutation.path?.endsWith(".context.md")),
      false
    );
  });

  test("should preview resolved prior-context items as the real context payload", async () => {
    const priorContextXml =
      "<priorContext><step>prior output</step></priorContext>";
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ userPromptText: "continue from prior output" }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => false,
      buildPriorContextXmlFromItems: (items) => {
        assert.deepStrictEqual(items, [{ index: 0, text: "prior output" }]);
        return priorContextXml;
      },
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        _directRefs,
        contextRefs,
        _excerptRefs,
        promptRefs
      ) => [...contextRefs, ...promptRefs].join(" | "),
    });

    const plan = await preparer.planPrompt(
      { prompt: "continue from prior output" } as PromptStep,
      {
        workflowName: "workflow",
        promptIndex: 1,
        allPrompts: [
          { prompt: "first" } as PromptStep,
          { prompt: "continue from prior output" } as PromptStep,
        ],
        resolvePriorContextItems: async () => [
          { index: 0, text: "prior output" },
        ],
      } as WorkflowContext,
      { priorContext: "allPrevious" } as any,
      undefined
    );

    const priorSection = plan.promptPreview.sections.find(
      (section) =>
        section.category === PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT
    );
    assert.ok(priorSection);
    assert.strictEqual(priorSection.body, priorContextXml);
    assert.strictEqual(
      priorSection.byteCount,
      Buffer.byteLength(priorContextXml, "utf8")
    );
    assert.ok(
      plan.mutations.some((mutation) => mutation.path?.endsWith(".context.md"))
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

  test("plans an oversized direct reference with an approximate token estimate, never reading it", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-plan-")
    );
    const referencePath = path.join(workspaceRoot, "large-reference.txt");
    await fs.promises.writeFile(referencePath, "not-read", "utf8");
    const hugeByteCount = 10 * 1024 * 1024 * 1024;
    await fs.promises.truncate(referencePath, hugeByteCount);

    const originalReadFile = fs.promises.readFile;
    let readFileCalls = 0;
    fs.promises.readFile = (async (
      ..._args: Parameters<typeof originalReadFile>
    ) => {
      readFileCalls++;
      throw new Error("Tier 1 references over MAX_CONTENT_SIZE must never be read");
    }) as typeof originalReadFile;

    try {
      const preparer = new CliPromptPreparer({
        shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
        buildPromptSections: async () =>
          createSections({
            directFileRefs: [referencePath],
            userPromptText: "inspect this reference",
          }),
        extractLeadingSlashCommand: () => null,
        isSimplePrompt: () => false,
        buildPriorContextXmlFromItems: () => "",
        getWorkspaceRoot: () => workspaceRoot,
        getTempFileSplitConfig: () => undefined,
        formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
        formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
        formatCategorizedReferences: (...refs) => refs.flat().join(" "),
      });

      const result = await preparer.planPrompt(
        { prompt: "inspect this reference" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );

      const referenceSection = result.promptPreview.sections.find(
        (section) =>
          section.category === PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE
      );
      assert.strictEqual(readFileCalls, 0);
      assert.strictEqual(referenceSection?.byteCount, hugeByteCount);
      assert.strictEqual(referenceSection?.path, referencePath);
      assert.strictEqual(
        referenceSection?.tokenEstimate,
        Math.ceil(hugeByteCount / ESTIMATED_CHARS_PER_TOKEN)
      );
      assert.ok(result.diagnostics.length > 0);
    } finally {
      fs.promises.readFile = originalReadFile;
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("plans a direct reference under MAX_CONTENT_SIZE with an exact token count", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-plan-")
    );
    const referencePath = path.join(workspaceRoot, "small-reference.ts");
    const fileContent = "export const greeting = 'hello world';\n".repeat(20);
    await fs.promises.writeFile(referencePath, fileContent, "utf8");

    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: [referencePath],
          userPromptText: "inspect this reference",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => false,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const result = await preparer.planPrompt(
        { prompt: "inspect this reference" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );

      const referenceSection = result.promptPreview.sections.find(
        (section) =>
          section.category === PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE
      );
      assert.strictEqual(
        referenceSection?.tokenEstimate,
        encode(fileContent).length
      );
      assert.strictEqual(
        referenceSection?.byteCount,
        Buffer.byteLength(fileContent, "utf8")
      );
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("withholds oversized inline content without a file read", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-plan-")
    );
    const originalReadFile = fs.promises.readFile;
    let readFileCalls = 0;
    fs.promises.readFile = (async (
      ..._args: Parameters<typeof originalReadFile>
    ) => {
      readFileCalls++;
      throw new Error("oversized Tier 2 content must not be read");
    }) as typeof originalReadFile;

    try {
      const preparer = new CliPromptPreparer({
        shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
        buildPromptSections: async () =>
          createSections({
            agentContent: "x".repeat(MAX_CONTENT_SIZE + 1),
            userPromptText: "use the agent",
          }),
        extractLeadingSlashCommand: () => null,
        isSimplePrompt: () => false,
        buildPriorContextXmlFromItems: () => "",
        getWorkspaceRoot: () => workspaceRoot,
        getTempFileSplitConfig: () => undefined,
        formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
        formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
        formatCategorizedReferences: (...refs) => refs.flat().join(" "),
      });

      const result = await preparer.planPrompt(
        { prompt: "use the agent" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );
      const agentSection = result.promptPreview.sections.find(
        (section) =>
          section.category === PREVIEW_PROMPT_CATEGORIES.AGENT_INSTRUCTIONS
      );
      assert.strictEqual(readFileCalls, 0);
      assert.strictEqual(agentSection?.body, undefined);
      assert.strictEqual(agentSection?.truncationReason, "over-inline-cap");
      assert.ok(
        result.diagnostics.some((diagnostic) =>
          diagnostic.code.includes("over-inline-cap")
        )
      );
    } finally {
      fs.promises.readFile = originalReadFile;
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("keeps preview bodies under the byte budget for a minified payload", async () => {
    const payload = "x".repeat(MAX_PREVIEW_BODY_BYTES * 2 + 17);
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ userPromptText: payload }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => false,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    const result = await preparer.planPrompt(
      { prompt: payload } as PromptStep,
      undefined,
      { harness: "codex-cli" } as any,
      undefined
    );

    const promptSections = result.promptPreview.sections.filter(
      (section) => section.category === PREVIEW_PROMPT_CATEGORIES.PROMPT_TEXT
    );
    assert.ok(promptSections.length > 1);
    assert.ok(
      result.promptPreview.includedBodyByteCount <= MAX_PREVIEW_BODY_BYTES
    );
    assert.ok(
      promptSections.some(
        (section) => section.truncationReason === "body-budget"
      )
    );
  });

  test("planning does not create categorized files and apply preserves the plan", async () => {
    const workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-prompt-plan-")
    );
    try {
      const preparer = new CliPromptPreparer({
        shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
        buildPromptSections: async () =>
          createSections({
            agentContent: "agent instructions",
            skillContent: "skill instructions",
            excerptContent: "<attachment>excerpt</attachment>",
            userPromptText: "prompt text",
          }),
        extractLeadingSlashCommand: () => null,
        isSimplePrompt: () => false,
        buildPriorContextXmlFromItems: () => "",
        getWorkspaceRoot: () => workspaceRoot,
        getTempFileSplitConfig: () => undefined,
        formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
        formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
        formatCategorizedReferences: (...refs) => refs.flat().join(" | "),
      });

      const plan = await preparer.planPrompt(
        { prompt: "prompt text" } as PromptStep,
        { workflowName: "workflow", promptIndex: 0, allPrompts: [] } as any,
        { harness: "copilot-cli" } as any,
        undefined
      );
      assert.ok(plan.mutations.length >= 4);
      assert.strictEqual(
        await fs.promises
          .access(path.join(workspaceRoot, ".ctrlyoke", "temp"))
          .then(() => true)
          .catch(() => false),
        false
      );

      const prepared = await preparer.preparePrompt(
        { prompt: "prompt text" } as PromptStep,
        { workflowName: "workflow", promptIndex: 0, allPrompts: [] } as any,
        { harness: "copilot-cli" } as any,
        undefined
      );
      assert.deepStrictEqual(prepared.tempFilePaths, plan.tempFilePaths);
      assert.strictEqual(
        prepared.promptWithInstruction,
        plan.promptWithInstruction
      );
      for (const filePath of plan.tempFilePaths) {
        await fs.promises.access(filePath);
      }
    } finally {
      await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
