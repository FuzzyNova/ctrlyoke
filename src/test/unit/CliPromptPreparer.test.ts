import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import { CliPromptPreparer } from "../../core/harness/shared/CliPromptPreparer";
import { ContextExpander } from "../../utils/ContextExpander";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import type { PromptSections } from "../../core/HarnessIntegration";
import type { PromptStep } from "../../types/CtrlYokeTypes";
import type { WorkflowContext } from "../../types/WorkflowContextTypes";
import type { ResolvedProperties } from "../../types/ExecutionPropertyTypes";
import { encode } from "gpt-tokenizer";
import {
  ESTIMATED_CHARS_PER_TOKEN,
  EXECUTION_MODES,
  MAX_CONTENT_SIZE,
  MAX_SOURCE_RUNTIME_ARTIFACT_COPY_BYTES,
  MAX_PREVIEW_BODY_BYTES,
  HARNESS_IDS,
  CTRLYOKE_MCP_MODES,
  MCP_SKILL_NAMES,
  PREVIEW_PROMPT_CATEGORIES,
  PREVIEW_TRUNCATION_REASONS,
  PROMPT_DIAGNOSTIC_CODES,
  TEMP_FILE_CATEGORIES,
} from "../../types/DashboardConstants";

function createSections(overrides?: Partial<PromptSections>): PromptSections {
  return {
    skillContent: null,
    agentContent: null,
    directFileRefs: [],
    imageFileRefs: [],
    sourceRuntimeCopies: [],
    sourceRuntimeReadReferences: [],
    excerptContent: null,
    userPromptText: "just say hi",
    skippedReferences: [],
    ...overrides,
  };
}

suite("CliPromptPreparer", () => {
  test("gives same-step plans unique categorized temp paths and applies those paths", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-plan-id-");
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ agentContent: "shared agent instructions" }),
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
      const context: WorkflowContext = {
        promptIndex: 0,
        allPrompts: [],
        workflowName: "same-workflow",
      };
      const first = await preparer.planPrompt(
        { prompt: "same prompt" } as PromptStep,
        context,
        undefined,
        undefined
      );
      const second = await preparer.planPrompt(
        { prompt: "same prompt" } as PromptStep,
        context,
        undefined,
        undefined
      );

      assert.ok(first.tempFilePaths.length > 0);
      assert.ok(
        first.tempFilePaths.every((filePath) =>
          path.basename(filePath).endsWith(".md")
        )
      );
      // Plan ID stays short so prompt @references remain readable.
      assert.ok(
        first.tempFilePaths.every((filePath) =>
          /^same-workflow-1-[0-9a-f]{8}\./.test(path.basename(filePath))
        )
      );
      assert.notDeepStrictEqual(first.tempFilePaths, second.tempFilePaths);
      for (const plan of [first, second]) {
        for (const mutation of plan.mutations) {
          await mutation.apply();
          assert.ok(mutation.path && fs.existsSync(mutation.path));
        }
      }
      assert.deepStrictEqual(
        first.mutations.map((mutation) => mutation.path),
        first.files.map((file) => file.path)
      );
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("uses inject-safe temp files for multiline prompts but keeps plain prompts inline", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (prompt) =>
        createSections({ userPromptText: prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      isInjectablePrompt: (promptText) => !/[\x00-\x1f\x7f]/u.test(promptText),
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" | "),
    });

    const properties = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "model",
      executionMode: EXECUTION_MODES.INTERACTIVE,
      resumeSession: false,
      mcpServers: [],
      hooks: null,
      toolPermissions: null,
    } satisfies ResolvedProperties;
    const multiline = await preparer.preparePrompt(
      { prompt: "first line\nsecond line" },
      undefined,
      properties,
      undefined,
      true
    );
    const singleLine = await preparer.preparePrompt(
      { prompt: "single line" },
      undefined,
      properties,
      undefined,
      true
    );

    assert.strictEqual(multiline.tempFilePaths.length, 1);
    assert.ok(multiline.promptWithInstruction.includes("@"));
    assert.deepStrictEqual(singleLine.tempFilePaths, []);
    assert.strictEqual(singleLine.promptWithInstruction, "single line");
    await new Promise<void>((resolve, reject) => {
      fs.rm(multiline.tempFilePaths[0], { force: true }, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  test("diagnoses the skill-mode MCP-to-skill replacement", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () => createSections(),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" | "),
    });

    const plan = await preparer.planPrompt(
      { prompt: "Use the queue tools" },
      undefined,
      {
        harness: HARNESS_IDS.CLAUDE_CLI,
        ctrlyokeMcpMode: CTRLYOKE_MCP_MODES.SKILL,
        skills: [MCP_SKILL_NAMES.TOOLS],
        model: "model",
        executionMode: EXECUTION_MODES.HEADLESS,
        resumeSession: false,
        mcpServers: ["ctrlyoke"],
        hooks: null,
        toolPermissions: null,
      } satisfies ResolvedProperties,
      undefined
    );

    assert.strictEqual(
      plan.diagnostics[0]?.code,
      PROMPT_DIAGNOSTIC_CODES.CTRLYOKE_MCP_MODE_SKILL
    );
  });

  test("does not diagnose skill-mode MCP when ctrlyoke was not requested", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () => createSections(),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" | "),
    });

    const plan = await preparer.planPrompt(
      { prompt: "No queue tools" },
      undefined,
      {
        harness: HARNESS_IDS.CLAUDE_CLI,
        ctrlyokeMcpMode: CTRLYOKE_MCP_MODES.SKILL,
        skills: undefined,
        model: "model",
        executionMode: EXECUTION_MODES.HEADLESS,
        resumeSession: false,
        mcpServers: [],
        hooks: null,
        toolPermissions: null,
      } satisfies ResolvedProperties,
      undefined
    );

    assert.deepStrictEqual(plan.diagnostics, []);
  });

  test("should not take the direct-reference fast path when excerpt content exists", async () => {
    // The fast path emits only the prompt text and its direct file references,
    // so excerpt content would be silently dropped from what reaches the
    // harness. Direct refs plus an excerpt must go through full assembly.
    let formattedExcerptRefs: string[] = [];
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: ["/workspace/Plan.md"],
          excerptContent: "<attachment>excerpt</attachment>",
          userPromptText: "summarize the plan",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        directRefs,
        contextRefs,
        excerptRefs,
        promptRefs
      ) => {
        formattedExcerptRefs = [...excerptRefs];
        return [
          ...directRefs,
          ...contextRefs,
          ...excerptRefs,
          ...promptRefs,
        ].join(" | ");
      },
    });

    const plan = await preparer.planPrompt(
      { prompt: "summarize the plan" } as PromptStep,
      undefined,
      undefined,
      undefined
    );

    assert.ok(
      formattedExcerptRefs.length > 0,
      "excerpt content must survive into the assembled prompt"
    );
    assert.ok(
      plan.promptPreview.sections.some(
        (section) =>
          section.category === PREVIEW_PROMPT_CATEGORIES.INLINE_REFERENCE
      ),
      "excerpt content must appear in the prompt preview"
    );
  });

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
      diagnostics: [],
      imageFileRefs: [],
      attachedSkills: [],
    });
  });

  test("should substitute both condition outputs before preparing a retry prompt", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (prompt) =>
        createSections({ userPromptText: prompt.prompt }),
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
          "Use pre=${pre} $preCondition:stdout and end=$end $endCondition:stderr",
      } as PromptStep,
      {
        promptIndex: 0,
        allPrompts: [],
        preConditionResult: {
          passed: false,
          script: "pre.js",
          actual: "pre-actual",
          stdout: "pre-output",
          stderr: "pre-error",
          durationMs: 1,
        },
        endConditionResult: {
          passed: false,
          script: "end.js",
          actual: "end-actual",
          stdout: "end-output",
          stderr: "end-error",
          durationMs: 1,
        },
      },
      undefined,
      undefined
    );

    assert.strictEqual(
      result.promptWithInstruction,
      "Use pre=${pre} \n``` text\npre-output\n```\n and end=$end " +
        "\n``` text\nend-error\n```\n"
    );
    assert.deepStrictEqual(result.diagnostics, []);
  });

  test("keeps condition output inert while resolving authored prompt references", async () => {
    const workspaceRoot = makeTempDir("cy-condition-output-refs-");
    const authoredFilePath = path.join(workspaceRoot, "src", "config.ts");
    fs.mkdirSync(path.dirname(authoredFilePath), { recursive: true });
    fs.writeFileSync(authoredFilePath, "export const config = true;\n");
    const expander = new ContextExpander({ workspaceRoot });
    let priorContextResolutionCount = 0;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (prompt) => {
        const split = await expander.expandContextSplit(prompt.prompt);
        return createSections({
          directFileRefs: split.directFileRefs,
          imageFileRefs: split.imageFileRefs,
          sourceRuntimeCopies: split.sourceRuntimeCopies,
          sourceRuntimeReadReferences: split.sourceRuntimeReadReferences,
          excerptContent: split.excerptBlocks || null,
          skippedReferences: split.skippedReferences,
          userPromptText: await expander.sanitizeReferences(
            prompt.prompt,
            (quotedPath) => `@${quotedPath}`
          ),
        });
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "prior context",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });
    const stdout = [
      "> @acme/web@1.0.0 test",
      "> vitest run",
      "FAIL test.ts: expected !CTRLYOKE_CONDITION_OUTPUT_SECRET; see @missing-from-output.ts",
      "Previous output: $previous",
      "Unavailable skill: /skill:not-installed",
    ].join("\n");

    try {
      const plan = await preparer.planPrompt(
        {
          prompt: "Inspect @src/config.ts. Test output:\n$endCondition:stdout",
        } as PromptStep,
        {
          promptIndex: 1,
          allPrompts: [],
          endConditionResult: {
            passed: false,
            script: "test.js",
            actual: "failed",
            stdout,
            stderr: "",
            durationMs: 1,
          },
          resolvePriorContextItems: async () => {
            priorContextResolutionCount++;
            return [];
          },
        } as unknown as WorkflowContext,
        undefined,
        undefined
      );

      assert.deepStrictEqual(plan.diagnostics, []);
      assert.deepStrictEqual(
        plan.promptPreview.sections
          .filter(
            (section) =>
              section.category === PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE
          )
          .map((section) => section.path),
        [authoredFilePath]
      );
      assert.strictEqual(priorContextResolutionCount, 0);
      assert.ok(plan.promptWithInstruction.includes(stdout));
      assert.ok(plan.promptWithInstruction.includes("@src/config.ts"));
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("should warn for unavailable condition output and avoid double substitution", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (prompt) =>
        createSections({ userPromptText: prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: () => "",
      formatTempFileRef: () => "",
      formatCategorizedReferences: () => "",
    });

    const unresolved = await preparer.planPrompt(
      { prompt: "$preCondition:stdout $endCondition:stdout" } as PromptStep,
      undefined,
      undefined,
      undefined
    );
    assert.strictEqual(
      unresolved.promptWithInstruction,
      "$preCondition:stdout $endCondition:stdout"
    );
    assert.deepStrictEqual(
      unresolved.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
      })),
      [
        {
          code: PROMPT_DIAGNOSTIC_CODES.CONDITION_OUTPUT_UNAVAILABLE,
          severity: "warning",
        },
        {
          code: PROMPT_DIAGNOSTIC_CODES.CONDITION_OUTPUT_UNAVAILABLE,
          severity: "warning",
        },
      ]
    );

    const literalContent = await preparer.planPrompt(
      { prompt: "The output was $preCondition:stdout" } as PromptStep,
      {
        promptIndex: 0,
        allPrompts: [],
        preConditionResult: {
          passed: true,
          script: "pre.js",
          actual: "literal",
          stdout: "$preCondition:stdout",
          stderr: "",
          durationMs: 1,
        },
      },
      undefined,
      undefined
    );
    assert.strictEqual(
      literalContent.promptWithInstruction,
      "The output was \n``` text\n$preCondition:stdout\n```\n"
    );
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
        diagnostics: [],
        imageFileRefs: [],
        attachedSkills: [],
      });
      assert.strictEqual(buildSectionsCalled, false);
    }
  });

  test("should attach and rewrite a discovered inline skill without mutating the prompt", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-inline-skill-");
    const skillPath = path.join(
      workspaceRoot,
      ".ctrlyoke",
      "skills",
      "commit",
      "SKILL.md"
    );
    await fs.promises.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.promises.writeFile(
      skillPath,
      "---\ndescription: Commit changes\n---\n",
      "utf8"
    );

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
      assert.deepStrictEqual(result.attachedSkills, ["commit"]);
      assert.ok(result.files.some((file) => file.content.includes("skill")));
      assert.strictEqual(
        result.files.find(
          (file) => file.category === TEMP_FILE_CATEGORIES.PROMPT
        )?.content,
        "skill: commit"
      );
      assert.strictEqual(prompt.prompt, "/skill:commit");
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("should merge inline skills with explicit skills without duplicates", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-inline-skill-");
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
        result.files.find(
          (file) => file.category === TEMP_FILE_CATEGORIES.PROMPT
        )?.content,
        "using skill: commit now"
      );
    } finally {
      removeTempDir(workspaceRoot);
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
    const workspaceRoot = makeTempDir("ctrlyoke-inline-skill-");
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
      assert.strictEqual(
        result.diagnostics[0].code,
        PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SKILL_REFERENCE
      );
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("should create an available-secrets category and preserve !NAME verbatim", async () => {
    let capturedSecretRefs: string[] = [];
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (prompt) =>
        createSections({ userPromptText: prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        _directRefs,
        _contextRefs,
        _excerptRefs,
        promptRefs,
        secretRefs
      ) => {
        capturedSecretRefs = [...(secretRefs ?? [])];
        return [...(secretRefs ?? []), ...promptRefs].join(" ");
      },
    });

    const result = await preparer.planPrompt(
      { prompt: "Use !API_TOKEN to authenticate" } as PromptStep,
      undefined,
      { harness: "claude-cli", secrets: ["API_TOKEN"] } as any,
      undefined
    );

    const secretFile = result.files.find(
      (file) => file.category === TEMP_FILE_CATEGORIES.SECRETS
    );
    assert.ok(secretFile);
    assert.strictEqual(
      secretFile.content,
      "<availableSecrets>\n" +
        "!API_TOKEN refers to API_TOKEN, a credential available to you as an environment variable in this shell. Read it by name (POSIX: $API_TOKEN, PowerShell: $env:API_TOKEN). Never print, echo, log, or inline its value.\n" +
        "</availableSecrets>"
    );
    assert.ok(capturedSecretRefs.length > 0);
    assert.strictEqual(
      result.files.find((file) => file.category === TEMP_FILE_CATEGORIES.PROMPT)
        ?.content,
      "Use !API_TOKEN to authenticate"
    );
  });

  test("should omit the secrets category and clause when there are no grants", async () => {
    let capturedSecretRefs: string[] | undefined;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({ agentContent: "agent instructions" }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (
        _agentRefs,
        _skillRefs,
        _directRefs,
        _contextRefs,
        _excerptRefs,
        promptRefs,
        secretRefs
      ) => {
        capturedSecretRefs = secretRefs;
        return promptRefs.join(" ");
      },
    });

    const result = await preparer.planPrompt(
      { prompt: "No credential needed" } as PromptStep,
      undefined,
      { harness: "claude-cli", secrets: [] } as any,
      undefined
    );

    assert.deepStrictEqual(capturedSecretRefs, []);
    assert.ok(
      result.files.every(
        (file) => file.category !== TEMP_FILE_CATEGORIES.SECRETS
      )
    );
  });

  test("should report an unknown inline secret as an error diagnostic", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (prompt) =>
        createSections({ userPromptText: prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    const result = await preparer.planPrompt(
      { prompt: "Use !CTRLYOKE_PHASE2_UNKNOWN_SECRET_9F7A" } as PromptStep,
      undefined,
      { harness: "claude-cli", secrets: [] } as any,
      undefined
    );

    assert.strictEqual(result.diagnostics.length, 1);
    assert.strictEqual(
      result.diagnostics[0].code,
      PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SECRET_REFERENCE
    );
    assert.strictEqual(result.diagnostics[0].severity, "error");
  });

  test("should not cap the available-secrets category as tier two content", async () => {
    const secretNames = Array.from(
      { length: 4000 },
      (_, index) => `PHASE2_SECRET_${index}`
    );
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (prompt) =>
        createSections({ userPromptText: prompt.prompt }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    const result = await preparer.planPrompt(
      { prompt: "Use the granted credentials" } as PromptStep,
      undefined,
      { harness: "claude-cli", secrets: secretNames } as any,
      undefined
    );

    assert.ok(
      result.promptPreview.sections
        .filter(
          (section) => section.category === PREVIEW_PROMPT_CATEGORIES.SECRETS
        )
        .every(
          (section) =>
            section.truncationReason !==
            PREVIEW_TRUNCATION_REASONS.OVER_INLINE_CAP
        )
    );
    assert.ok(
      !result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === PROMPT_DIAGNOSTIC_CODES.OVER_INLINE_CAP
      )
    );
    assert.ok(MAX_CONTENT_SIZE > 0);
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

  test("re-attaches previously attached skills when resume omission is off", async () => {
    const workspaceRoot = makeTempDir(
      "ctrlyoke-resume-agent-skill-setting-off-"
    );
    const agentDir = path.join(workspaceRoot, ".ctrlyoke", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "current.agent.md"),
      "---\nname: current\nskills: [shared-skill]\n---\nCurrent agent"
    );
    let capturedSkills: string[] | undefined;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async (_prompt, _agent, skills) => {
        capturedSkills = skills;
        return createSections();
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (value) => value,
      formatTempFileRef: (_manager, value) => value,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      await preparer.planPrompt(
        { prompt: "resume", agent: "current", skills: null } as PromptStep,
        {
          promptIndex: 1,
          allPrompts: [
            {
              prompt: "start",
              _runtime: {
                completedAt: 2,
                sessionId: "existing-session",
                harness: HARNESS_IDS.CLAUDE_CLI,
                agent: "previous",
                skills: ["shared-skill"],
              },
            },
            { prompt: "resume" } as PromptStep,
          ],
        } as WorkflowContext,
        {
          harness: HARNESS_IDS.CLAUDE_CLI,
          agent: "current",
          skills: null,
        } as any,
        "existing-session"
      );

      assert.deepStrictEqual(capturedSkills, ["shared-skill"]);
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("filters an agent-declared skill already attached by the previous agent", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-resume-agent-skill-");
    const agentDir = path.join(workspaceRoot, ".ctrlyoke", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "current.agent.md"),
      "---\nname: current\nskills: [shared-skill]\n---\nCurrent agent"
    );
    let capturedSkills: string[] | undefined;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => true,
      buildPromptSections: async (_prompt, _agent, skills) => {
        capturedSkills = skills;
        return createSections({ agentContent: "Current agent" });
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (value) => value,
      formatTempFileRef: (_manager, value) => value,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const plan = await preparer.planPrompt(
        { prompt: "continue", agent: "current" } as PromptStep,
        {
          promptIndex: 1,
          allPrompts: [
            {
              prompt: "start",
              _runtime: {
                completedAt: 2,
                sessionId: "session-a",
                harness: HARNESS_IDS.CLAUDE_CLI,
                agent: "previous",
                skills: ["shared-skill"],
              },
            } as PromptStep,
            { prompt: "continue" } as PromptStep,
          ],
        } as WorkflowContext,
        { harness: HARNESS_IDS.CLAUDE_CLI, agent: "current" } as any,
        "session-a"
      );

      assert.deepStrictEqual(capturedSkills, undefined);
      assert.deepStrictEqual(plan.attachedSkills, []);
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("filters an agent-declared skill duplicated by explicit step skills", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-resume-explicit-agent-skill-");
    const agentDir = path.join(workspaceRoot, ".ctrlyoke", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "current.agent.md"),
      "---\nname: current\nskills: [shared-skill]\n---\nCurrent agent"
    );
    let capturedSkills: string[] | undefined;
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => true,
      buildPromptSections: async (_prompt, _agent, skills) => {
        capturedSkills = skills;
        return createSections();
      },
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (value) => value,
      formatTempFileRef: (_manager, value) => value,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const plan = await preparer.planPrompt(
        { prompt: "continue", skills: ["shared-skill"] } as PromptStep,
        {
          promptIndex: 1,
          allPrompts: [
            {
              prompt: "start",
              _runtime: {
                completedAt: 2,
                sessionId: "session-a",
                harness: HARNESS_IDS.CLAUDE_CLI,
                agent: "previous",
                skills: ["shared-skill"],
              },
            } as PromptStep,
            { prompt: "continue" } as PromptStep,
          ],
        } as WorkflowContext,
        {
          harness: HARNESS_IDS.CLAUDE_CLI,
          agent: "current",
          skills: ["shared-skill"],
        } as any,
        "session-a"
      );

      assert.deepStrictEqual(capturedSkills, undefined);
      assert.deepStrictEqual(plan.attachedSkills, []);
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("keeps agent-declared skills on a non-resumed step, including skills null", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-agent-skill-null-");
    const agentDir = path.join(workspaceRoot, ".ctrlyoke", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "current.agent.md"),
      "---\nname: current\nskills: [declared-skill]\n---\nCurrent agent"
    );
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => true,
      buildPromptSections: async (_prompt, _agent, skills) =>
        createSections({ skillContent: skills?.join(",") ?? null }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => workspaceRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (value) => value,
      formatTempFileRef: (_manager, value) => value,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const plan = await preparer.planPrompt(
        { prompt: "continue", skills: null } as PromptStep,
        undefined,
        {
          harness: HARNESS_IDS.CLAUDE_CLI,
          agent: "current",
          skills: null,
        } as any,
        undefined
      );
      assert.deepStrictEqual(plan.attachedSkills, ["declared-skill"]);
    } finally {
      removeTempDir(workspaceRoot);
    }
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
      (section) => section.category === PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT
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
      (section) => section.category === PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT
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
      diagnostics: [],
      imageFileRefs: [],
      attachedSkills: [],
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
      diagnostics: [],
      imageFileRefs: [],
      attachedSkills: [],
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
      diagnostics: [],
      imageFileRefs: [],
      attachedSkills: [],
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
        diagnostics: [],
        imageFileRefs: [],
        attachedSkills: [],
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
        diagnostics: [],
        imageFileRefs: [],
        attachedSkills: [],
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
        diagnostics: [],
        imageFileRefs: [],
        attachedSkills: [],
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
    const workspaceRoot = makeTempDir("ctrlyoke-prompt-plan-");
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
      throw new Error(
        "Tier 1 references over MAX_CONTENT_SIZE must never be read"
      );
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
      removeTempDir(workspaceRoot);
    }
  });

  test("plans a direct reference under MAX_CONTENT_SIZE with an exact token count", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-prompt-plan-");
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
      removeTempDir(workspaceRoot);
    }
  });

  test("withholds oversized inline content without a file read", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-prompt-plan-");
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
      removeTempDir(workspaceRoot);
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
    const workspaceRoot = makeTempDir("ctrlyoke-prompt-plan-");
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

      for (const mutation of plan.mutations) {
        await mutation.apply();
      }
      assert.deepStrictEqual(
        plan.tempFilePaths,
        plan.files.map((file) => file.path)
      );
      for (const plannedPath of plan.tempFilePaths) {
        await fs.promises.access(plannedPath);
      }
    } finally {
      removeTempDir(workspaceRoot);
    }
  });

  test("defers a source-runtime copy until preparePrompt", async () => {
    const sourceRoot = makeTempDir("ctrlyoke-source-copy-");
    const executionRoot = makeTempDir("ctrlyoke-execution-copy-");
    const sourcePath = path.join(sourceRoot, "runtime", "large.log");
    const destinationPath = path.join(executionRoot, "runtime", "large.log");
    const content = Buffer.alloc(MAX_CONTENT_SIZE + 1024, 65);
    assert.ok(content.byteLength < MAX_SOURCE_RUNTIME_ARTIFACT_COPY_BYTES);
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, content);

    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: [destinationPath],
          sourceRuntimeCopies: [
            { reference: "@runtime/large.log", sourcePath, destinationPath },
          ],
          sourceRuntimeReadReferences: [
            "@runtime/other.log",
            "@runtime/another.log",
          ],
          userPromptText: "Review @runtime/large.log",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => executionRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      const plan = await preparer.planPrompt(
        { prompt: "Review @runtime/large.log" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );
      assert.strictEqual(fs.existsSync(destinationPath), false);
      assert.strictEqual(plan.mutations.length, 1);
      assert.strictEqual(plan.mutations[0].path, destinationPath);
      assert.ok(plan.mutations[0].description?.includes(sourcePath));
      assert.deepStrictEqual(
        plan.diagnostics.map(({ severity, message }) => ({
          severity,
          message,
        })),
        [
          {
            severity: "info",
            message: `Read from source checkout: @runtime/other.log, @runtime/another.log; Copied into worktree: @runtime/large.log → ${destinationPath}`,
          },
        ]
      );

      const prepared = await preparer.preparePrompt(
        { prompt: "Review @runtime/large.log" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );
      assert.deepStrictEqual(prepared.diagnostics, plan.diagnostics);
      assert.deepStrictEqual(
        await fs.promises.readFile(destinationPath),
        content
      );
    } finally {
      removeTempDir(sourceRoot);
      removeTempDir(executionRoot);
    }
  });

  test("skips identical copies and overwrites stale prompt and log destinations", async () => {
    const sourceRoot = makeTempDir("ctrlyoke-source-copy-");
    const executionRoot = makeTempDir("ctrlyoke-execution-copy-");
    const files = [
      {
        name: "prompt.md",
        source: "new prompt\n",
        destination: "old prompt\n",
      },
      {
        name: "session.log",
        source: "new log\n",
        destination: "old log\n",
      },
      {
        name: "attachment.png",
        source: "same attachment bytes",
        destination: "same attachment bytes",
      },
    ].map((file) => ({
      name: file.name,
      sourcePath: path.join(sourceRoot, "runtime", file.name),
      destinationPath: path.join(executionRoot, "runtime", file.name),
      source: file.source,
      destination: file.destination,
    }));

    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          directFileRefs: files.map((file) => file.destinationPath),
          sourceRuntimeCopies: files.map(
            ({ sourcePath, destinationPath, name }) => ({
              reference: `@runtime/${name}`,
              sourcePath,
              destinationPath,
            })
          ),
          userPromptText: "Review the runtime files",
        }),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => executionRoot,
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    try {
      for (const file of files) {
        await fs.promises.mkdir(path.dirname(file.sourcePath), {
          recursive: true,
        });
        await fs.promises.writeFile(file.sourcePath, file.source);
        await fs.promises.mkdir(path.dirname(file.destinationPath), {
          recursive: true,
        });
        await fs.promises.writeFile(file.destinationPath, file.destination);
      }

      const plan = await preparer.planPrompt(
        { prompt: "Review the runtime files" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );
      assert.deepStrictEqual(
        plan.mutations.map((mutation) => mutation.path),
        files
          .filter((file) => file.source !== file.destination)
          .map((file) => file.destinationPath)
      );
      assert.strictEqual(
        plan.diagnostics[0]?.message,
        `Copied into worktree: @runtime/prompt.md → ${files[0].destinationPath}, @runtime/session.log → ${files[1].destinationPath}`
      );

      await preparer.preparePrompt(
        { prompt: "Review the runtime files" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );
      for (const file of files) {
        assert.strictEqual(
          await fs.promises.readFile(file.destinationPath, "utf8"),
          file.source
        );
      }
    } finally {
      removeTempDir(sourceRoot);
      removeTempDir(executionRoot);
    }
  });

  test("does not plan source-runtime copies for a non-worktree prompt", async () => {
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () => createSections(),
      extractLeadingSlashCommand: () => null,
      isSimplePrompt: () => true,
      buildPriorContextXmlFromItems: () => "",
      getWorkspaceRoot: () => process.cwd(),
      getTempFileSplitConfig: () => undefined,
      formatDirectFileRef: (absolutePath) => `@${absolutePath}`,
      formatTempFileRef: (_tempMgr, absolutePath) => `@${absolutePath}`,
      formatCategorizedReferences: (...refs) => refs.flat().join(" "),
    });

    const plan = await preparer.planPrompt(
      { prompt: "just say hi" } as PromptStep,
      undefined,
      { harness: "claude-cli" } as any,
      undefined
    );
    assert.strictEqual(
      plan.mutations.filter((mutation) =>
        mutation.description?.startsWith("Copy ")
      ).length,
      0
    );
  });

  test("lists source references when only source reads are present", async () => {
    const workspaceRoot = makeTempDir("ctrlyoke-source-disclosure-");
    const preparer = new CliPromptPreparer({
      shouldOmitPreviouslyAttachedAgentsAndSkillsOnResume: () => false,
      buildPromptSections: async () =>
        createSections({
          excerptContent: "source excerpt",
          sourceRuntimeReadReferences: ["@runtime/excerpt.log"],
          userPromptText: "Review the excerpt",
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
      const plan = await preparer.planPrompt(
        { prompt: "Review the excerpt" } as PromptStep,
        undefined,
        { harness: "claude-cli" } as any,
        undefined
      );
      assert.strictEqual(
        plan.diagnostics[0]?.message,
        "Read from source checkout: @runtime/excerpt.log"
      );
    } finally {
      removeTempDir(workspaceRoot);
    }
  });
});
