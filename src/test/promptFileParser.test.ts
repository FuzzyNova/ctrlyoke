import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { PromptFileParser } from "../core/PromptFileParser";
import type { PromptStep, WorkflowStep } from "../types/CtrlYokeTypes";
import { WORKFLOW_VALIDATION_WARNING_CODES } from "../types/DashboardConstants";

suite("PromptFileParser Tests", () => {
  let parser: PromptFileParser;
  // Fixtures are in src/test/fixtures, but tests run from out/test
  // So we need to navigate from out/test to src/test/fixtures
  const fixturesPath = path.join(
    __dirname,
    "..",
    "..",
    "src",
    "test",
    "fixtures",
    "prompts"
  );

  /**
   * Helper to assert result is valid and has prompts
   */
  function assertValidResult(result: any): asserts result is {
    steps: any[];
    errorBehavior?: unknown;
    hooks?: unknown;
  } {
    assert.ok(result, "Result should not be null");
    assert.ok(result.steps, "Should have prompts array");
    assert.ok(result.steps.length > 0, "Should have at least one prompt");
  }

  setup(() => {
    parser = new PromptFileParser();
  });

  suite("unknown root property warnings", () => {
    const workflow = {
      harness: "claude-cli",
      steps: [{ type: "script", script: "echo 1" }],
    };

    test("does not flag valid workflow keys beside an unknown root key", () => {
      const warnings = parser.getSchemaWarnings({ ...workflow, name: "k" });

      assert.deepStrictEqual(
        warnings.map((warning) => warning.propertyPointer),
        ["/name"]
      );
      assert.ok(!warnings[0].message.includes("Did you mean 'name'?"));
    });

    test("flags only color when it is the only unknown root key", () => {
      const warnings = parser.getSchemaWarnings({
        ...workflow,
        color: "#ff0000",
      });

      assert.deepStrictEqual(
        warnings.map((warning) => warning.propertyPointer),
        ["/color"]
      );
    });

    test("reports only truly unknown root keys", () => {
      const warnings = parser.getSchemaWarnings({
        ...workflow,
        name: "k",
        color: "#ff0000",
      });

      assert.deepStrictEqual(
        warnings.map((warning) => warning.propertyPointer).sort(),
        ["/color", "/name"]
      );
    });
  });

  suite("parsePromptFile - JSON Format", () => {
    test("preserves a script step shell override", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-script-shell-")
      );
      const filePath = path.join(tempDir, "shell.ctrlyoke.json");

      try {
        await fs.writeFile(
          filePath,
          JSON.stringify({
            steps: [{ type: "script", script: "echo shell", shell: "bash" }],
          }),
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assert.ok(result);
        const scriptStep = result.steps?.[0];
        assert.ok(scriptStep && "shell" in scriptStep);
        assert.strictEqual(scriptStep.shell, "bash");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("round-trips authored colors for prompt and script steps", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-step-color-")
      );
      const filePath = path.join(tempDir, "colors.ctrlyoke.json");

      try {
        await fs.writeFile(
          filePath,
          JSON.stringify({
            steps: [
              { prompt: "prompt", color: "#A1b2C3" },
              { type: "script", script: "npm test", color: "#123456" },
            ],
            finalStep: { prompt: "final", color: "#abcdef" },
          }),
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assert.ok(result);
        assert.ok(result.steps);
        assert.strictEqual(result.steps[0].color, "#A1b2C3");
        assert.strictEqual(result.steps[1].color, "#123456");
        assert.strictEqual(result.finalStep?.color, "#abcdef");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should parse single prompt format", async () => {
      const filePath = path.join(fixturesPath, "single.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);

      assert.ok(result, "Result should not be null");
      assert.ok(result.steps, "Should have prompts array");
      assert.strictEqual(result.steps.length, 1);
      assert.strictEqual(
        (result.steps[0] as PromptStep).prompt,
        "Explain this code and suggest improvements"
      );
      assert.strictEqual(
        (result.steps[0] as PromptStep).model,
        "claude-sonnet-4.5"
      );
    });

    test("should parse multiple prompts format", async () => {
      const filePath = path.join(fixturesPath, "multi.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);

      assert.ok(result, "Result should not be null");
      assert.ok(result.steps, "Should have prompts array");
      assert.strictEqual(result.steps.length, 2);
      assert.strictEqual(
        (result.steps[0] as PromptStep).prompt,
        "Step 1: Analyze code structure"
      );
      assert.strictEqual(
        (result.steps[1] as PromptStep).prompt,
        "Step 2: Implement improvements"
      );
    });

    test("should return null for invalid JSON", async () => {
      // Test error handling for non-existent files
      const filePath = path.join(fixturesPath, "nonexistent.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);
      assert.strictEqual(result, null);
    });

    test("should normalize single prompt to prompts array", async () => {
      const filePath = path.join(fixturesPath, "single.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);

      assert.ok(result);
      assert.ok(Array.isArray(result.steps));
      assert.strictEqual(result.steps.length, 1);
    });

    test("should preserve endCondition in parsed result", async () => {
      const filePath = path.join(fixturesPath, "single.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      const endCondition = result.steps[0].endCondition;
      assert.ok(endCondition);
      assert.strictEqual(endCondition.script, "check_explanation.py");
      assert.strictEqual(endCondition.expected, undefined);
      assert.strictEqual(endCondition.timeoutSec, 30);
    });

    test("should preserve errorBehavior in parsed result", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-error-behavior-")
      );
      const filePath = path.join(tempDir, "error-behavior.ctrlyoke.json");

      try {
        await fs.writeFile(
          filePath,
          JSON.stringify(
            {
              errorBehavior: {
                onError: "retry",
                maxRetries: 3,
                retryDelaySec: 1,
              },
              hooks: [{ event: "error", command: "echo hook" }],
              steps: [
                {
                  prompt: "Test prompt",
                  errorBehavior: { onError: "continue" },
                },
              ],
            },
            null,
            2
          ),
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.deepStrictEqual(result.errorBehavior, {
          onError: "retry",
          maxRetries: 3,
          retryDelaySec: 1,
        });
        assert.deepStrictEqual(result.hooks, [
          { event: "error", command: "echo hook" },
        ]);
        assert.deepStrictEqual(result.steps[0].errorBehavior, {
          onError: "continue",
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should reject invalid errorBehavior values", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-error-behavior-invalid-")
      );
      const filePath = path.join(
        tempDir,
        "invalid-error-behavior.ctrlyoke.json"
      );

      try {
        await fs.writeFile(
          filePath,
          JSON.stringify(
            {
              steps: [
                {
                  prompt: "Test prompt",
                  errorBehavior: { onError: "explode" },
                },
              ],
            },
            null,
            2
          ),
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);
        assert.strictEqual(result, null);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should accept onPass retry and preserve the action", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-on-pass-retry-")
      );
      const filePath = path.join(tempDir, "on-pass-retry.ctrlyoke.json");

      try {
        await fs.writeFile(
          filePath,
          JSON.stringify(
            {
              steps: [
                {
                  prompt: "Test prompt",
                  endCondition: {
                    script: "npm test",
                    onPass: "retry",
                  },
                },
              ],
            },
            null,
            2
          ),
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);
        assertValidResult(result);
        assert.strictEqual(
          (result.steps[0] as PromptStep).endCondition?.onPass,
          "retry"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should keep resumeSession undefined when not explicitly set (uses global setting at execution time)", async () => {
      const filePath = path.join(fixturesPath, "multi.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      // Prompts without explicit resumeSession should be undefined (will use global setting at execution time)
      assert.strictEqual(result.steps[0].resumeSession, undefined);
      assert.strictEqual(result.steps[1].resumeSession, undefined);
    });

    test("should preserve enabled on prompt steps, script steps, and finalStep", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-enabled-")
      );
      const filePath = path.join(tempDir, "enabled.ctrlyoke.json");

      try {
        await fs.writeFile(
          filePath,
          JSON.stringify(
            {
              steps: [
                { prompt: "enabled prompt", enabled: false },
                { type: "script", script: "echo hi", enabled: false },
              ],
              finalStep: { prompt: "final prompt", enabled: false },
            },
            null,
            2
          ),
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.strictEqual(result.steps[0].enabled, false);
        assert.strictEqual(result.steps[1].enabled, false);
        assert.strictEqual((result as any).finalStep?.enabled, false);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  suite("parallel groups", () => {
    async function writeWorkflow(
      extension: ".ctrlyoke.json" | ".ctrlyoke.yaml",
      content: string
    ): Promise<{ tempDir: string; filePath: string }> {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-parallel-")
      );
      const filePath = path.join(tempDir, `parallel${extension}`);
      await fs.writeFile(filePath, content, "utf8");
      return { tempDir, filePath };
    }

    test("should flatten JSON parallel containers and assign flat indices", async () => {
      const { tempDir, filePath } = await writeWorkflow(
        ".ctrlyoke.json",
        JSON.stringify({
          steps: [
            { prompt: "before" },
            {
              parallel: [
                { prompt: "parallel prompt" },
                { type: "script", script: "echo parallel script" },
              ],
              failFast: false,
            },
            { prompt: "after" },
          ],
        })
      );

      try {
        const result = await parser.parsePromptFile(filePath);

        assert.ok(result);
        assert.deepStrictEqual(
          result.steps?.map((step) =>
            "prompt" in step ? step.prompt : step.script
          ),
          ["before", "parallel prompt", "echo parallel script", "after"]
        );
        assert.strictEqual(result.parallelGroups?.length, 1);
        assert.deepStrictEqual(result.parallelGroups?.[0], {
          id: result.parallelGroups?.[0].id,
          startIndex: 1,
          endIndex: 2,
          failFast: false,
        });
        assert.match(result.parallelGroups?.[0].id ?? "", /^[0-9a-f-]{36}$/);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should parse YAML groups at index zero and default failFast", async () => {
      const { tempDir, filePath } = await writeWorkflow(
        ".ctrlyoke.yaml",
        [
          "steps:",
          "  - parallel:",
          "      - prompt: first",
          "      - prompt: second",
          "  - prompt: after",
        ].join("\n")
      );

      try {
        const result = await parser.parsePromptFile(filePath);

        assert.ok(result);
        assert.strictEqual(result.steps?.length, 3);
        assert.deepStrictEqual(result.parallelGroups?.[0], {
          id: result.parallelGroups?.[0].id,
          startIndex: 0,
          endIndex: 1,
          failFast: true,
        });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("merges YAML step defaults and lets explicit step values override them", async () => {
      const { tempDir, filePath } = await writeWorkflow(
        ".ctrlyoke.yaml",
        [
          "x-defaults: &defaults",
          "  model: gpt-5",
          "  name: default name",
          "steps:",
          "  - <<: *defaults",
          "    name: explicit name",
          "    prompt: merged step",
        ].join("\n")
      );

      try {
        const result = await parser.parsePromptFile(filePath);

        assert.ok(result);
        assert.strictEqual((result.steps?.[0] as PromptStep).model, "gpt-5");
        assert.strictEqual(result.steps?.[0].name, "explicit name");
        assert.strictEqual(
          (result.steps?.[0] as PromptStep).prompt,
          "merged step"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("merges a step from an anchored step with only a name override", async () => {
      const { tempDir, filePath } = await writeWorkflow(
        ".ctrlyoke.yaml",
        [
          "steps:",
          "  - &s1",
          "    prompt: anchored prompt",
          "    model: gpt-5",
          "  - <<: *s1",
          "    name: copied step",
        ].join("\n")
      );

      try {
        const result = await parser.parsePromptFile(filePath);

        assert.ok(result);
        assert.strictEqual(
          (result.steps?.[1] as PromptStep).prompt,
          "anchored prompt"
        );
        assert.strictEqual((result.steps?.[1] as PromptStep).model, "gpt-5");
        assert.strictEqual(result.steps?.[1].name, "copied step");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    const invalidCases: Array<{
      name: string;
      workflow: unknown;
      message: RegExp;
    }> = [
      {
        name: "root parallel property",
        workflow: {
          parallel: [{ prompt: "one" }, { prompt: "two" }],
        },
        message: /parallel.*only accepted.*root `steps` array/i,
      },
      {
        name: "single-member group",
        workflow: {
          steps: [{ parallel: [{ prompt: "only" }] }],
        },
        message: /Step 1: parallel must contain at least two/i,
      },
      {
        name: "nested group",
        workflow: {
          steps: [
            {
              parallel: [
                { prompt: "one" },
                {
                  parallel: [
                    { prompt: "nested one" },
                    { prompt: "nested two" },
                  ],
                },
              ],
            },
          ],
        },
        message: /nested parallel container/i,
      },
      {
        name: "parallel final step",
        workflow: {
          steps: [{ prompt: "queued" }],
          finalStep: {
            parallel: [{ prompt: "one" }, { prompt: "two" }],
          },
        },
        message: /finalStep cannot be parallel/i,
      },
      {
        name: "mixed authored and normalized groups",
        workflow: {
          steps: [
            {
              parallel: [{ prompt: "one" }, { prompt: "two" }],
            },
          ],
          parallelGroups: [
            { id: "existing", startIndex: 0, endIndex: 1, failFast: true },
          ],
        },
        message: /both `parallel:` items and root `parallelGroups`/i,
      },
      {
        name: "invalid normalized range",
        workflow: {
          steps: [{ prompt: "one" }, { prompt: "two" }],
          parallelGroups: [
            { id: "invalid", startIndex: 0, endIndex: 0, failFast: true },
          ],
        },
        message: /must contain at least two steps/i,
      },
      {
        name: "numeric priorContext sibling",
        workflow: {
          steps: [
            {
              parallel: [
                { prompt: "one", priorContext: [2] },
                { prompt: "two" },
              ],
            },
          ],
        },
        message: /Step 1: Numeric priorContext reference 2.*steps 1, 2/i,
      },
      {
        name: "inline summary priorContext sibling",
        workflow: {
          steps: [
            {
              parallel: [
                { prompt: "one $summary:step:2" },
                { prompt: "two" },
              ],
            },
          ],
        },
        message: /Inline priorContext reference 2.*steps 1, 2/i,
      },
      {
        name: "numeric sessionId sibling",
        workflow: {
          steps: [
            {
              parallel: [{ prompt: "one", sessionId: 2 }, { prompt: "two" }],
            },
          ],
        },
        message: /Step 1: Numeric sessionId reference 2.*steps 1, 2/i,
      },
      {
        name: "unsupported member type",
        workflow: {
          steps: [
            {
              parallel: [
                { prompt: "one" },
                { type: "userInput", prompt: "unsupported" },
              ],
            },
          ],
        },
        message: /parallel member 2 must be a prompt or script step/i,
      },
    ];

    for (const invalidCase of invalidCases) {
      test(`should reject ${invalidCase.name}`, async () => {
        await assert.rejects(
          () =>
            parser.validateAndNormalize(
              invalidCase.workflow,
              path.join(os.tmpdir(), "parallel-validation.ctrlyoke.json")
            ),
          invalidCase.message
        );
      });
    }
  });

  suite("BOM-prefixed workflow files", () => {
    test("strips a leading BOM before parsing JSON workflows", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-json-bom-")
      );
      const filePath = path.join(tempDir, "workflow.ctrlyoke.json");

      try {
        await fs.writeFile(
          filePath,
          `\uFEFF${JSON.stringify({ prompt: "JSON workflow" })}`,
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.strictEqual(result.steps[0].prompt, "JSON workflow");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("strips a leading BOM before parsing YAML workflows", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-yaml-bom-")
      );
      const filePath = path.join(tempDir, "workflow.ctrlyoke.yaml");

      try {
        await fs.writeFile(
          filePath,
          "\uFEFFsteps:\n  - prompt: YAML workflow\n",
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.strictEqual(result.steps[0].prompt, "YAML workflow");
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("strips a leading BOM before applying Markdown frontmatter", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-bom-")
      );
      const filePath = path.join(tempDir, "workflow.prompt.md");

      try {
        await fs.writeFile(
          filePath,
          "\uFEFF---\r\nschemaVersion: 1\r\n---\r\nMarkdown workflow\r\n",
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.strictEqual(result.schemaVersion, 1);
        assert.strictEqual(
          (result.steps[0] as PromptStep).prompt,
          "Markdown workflow"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  suite("parseMarkdownPromptFile", () => {
    test("strips an empty leading frontmatter block", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-empty-frontmatter-")
      );
      const filePath = path.join(tempDir, "workflow.prompt.md");

      try {
        await fs.writeFile(filePath, "---\n---\nHello world", "utf8");

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.strictEqual(
          (result.steps[0] as PromptStep).prompt,
          "Hello world"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("preserves prose after empty frontmatter before a later delimiter", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-empty-frontmatter-")
      );
      const filePath = path.join(tempDir, "workflow.prompt.md");

      try {
        await fs.writeFile(
          filePath,
          "---\n---\nIntro text\n\n---\n\nMore text",
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.strictEqual(
          (result.steps[0] as PromptStep).prompt,
          "Intro text\n\n---\n\nMore text"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("rejects non-object frontmatter with a clear error", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-invalid-frontmatter-")
      );
      const filePath = path.join(tempDir, "workflow.prompt.md");

      try {
        await fs.writeFile(
          filePath,
          "---\njust a scalar\n---\nHello world",
          "utf8"
        );

        assert.strictEqual(await parser.parsePromptFile(filePath), null);
        assert.match(
          parser.lastParseError?.message ?? "",
          /Markdown frontmatter must contain a YAML mapping or null/
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("continues to parse normal frontmatter", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-frontmatter-")
      );
      const filePath = path.join(tempDir, "workflow.prompt.md");

      try {
        await fs.writeFile(
          filePath,
          "---\nschemaVersion: 1\n---\nMarkdown workflow",
          "utf8"
        );

        const result = await parser.parsePromptFile(filePath);

        assertValidResult(result);
        assert.strictEqual(result.schemaVersion, 1);
        assert.strictEqual(
          (result.steps[0] as PromptStep).prompt,
          "Markdown workflow"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("names the step from the frontmatter description and ignores foreign keys", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-description-")
      );

      try {
        const described = path.join(tempDir, "described.prompt.md");
        await fs.writeFile(
          described,
          "---\ndescription: |\n  Review the\n  staged diff\nmodel: GPT-4o\ntools: [codebase]\nagent: agent\n---\nReview it.",
          "utf8"
        );
        const long = path.join(tempDir, "long.prompt.md");
        await fs.writeFile(
          long,
          `---\ndescription: ${"x".repeat(150)}\n---\nBody`,
          "utf8"
        );
        const nonString = path.join(tempDir, "non-string.prompt.md");
        await fs.writeFile(
          nonString,
          "---\ndescription: 42\n---\nBody",
          "utf8"
        );

        const describedResult = await parser.parsePromptFile(described);
        assertValidResult(describedResult);
        const step = describedResult.steps[0] as PromptStep;
        assert.strictEqual(step.name, "Review the staged diff");
        assert.strictEqual(step.prompt, "Review it.");
        assert.strictEqual(step.model, undefined);
        assert.strictEqual(step.agent, undefined);

        const longResult = await parser.parsePromptFile(long);
        assertValidResult(longResult);
        const longName = (longResult.steps[0] as PromptStep).name ?? "";
        assert.strictEqual(longName.length, 100);
        assert.ok(longName.endsWith("…"));

        const nonStringResult = await parser.parsePromptFile(nonString);
        assertValidResult(nonStringResult);
        assert.strictEqual(
          (nonStringResult.steps[0] as PromptStep).name,
          undefined
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("parses empty frontmatter and closing fences with trailing whitespace", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-frontmatter-shapes-")
      );

      try {
        const emptyFrontmatterPath = path.join(tempDir, "empty.prompt.md");
        await fs.writeFile(
          emptyFrontmatterPath,
          "---\n---\nEmpty metadata body",
          "utf8"
        );
        const emptyFrontmatterResult =
          await parser.parsePromptFile(emptyFrontmatterPath);
        assertValidResult(emptyFrontmatterResult);
        assert.strictEqual(
          (emptyFrontmatterResult.steps[0] as PromptStep).prompt,
          "Empty metadata body"
        );

        const paddedFencePath = path.join(tempDir, "padded.prompt.md");
        await fs.writeFile(
          paddedFencePath,
          "---\nschemaVersion: 1\n--- \t\nPadded metadata body",
          "utf8"
        );
        const paddedFenceResult = await parser.parsePromptFile(paddedFencePath);
        assertValidResult(paddedFenceResult);
        assert.strictEqual(
          (paddedFenceResult.steps[0] as PromptStep).prompt,
          "Padded metadata body"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("parses comment-only frontmatter as an absent YAML document", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-markdown-comment-frontmatter-")
      );
      const filePath = path.join(tempDir, "comment.prompt.md");
      try {
        await fs.writeFile(
          filePath,
          "---\n# Metadata intentionally omitted\n---\nPrompt body",
          "utf8"
        );
        const result = await parser.parsePromptFile(filePath);
        assertValidResult(result);
        assert.strictEqual(
          (result.steps[0] as PromptStep).prompt,
          "Prompt body"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("keeps the friendly error for an empty workflow YAML file", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-empty-workflow-yaml-")
      );
      const filePath = path.join(tempDir, "empty.ctrlyoke.yaml");
      try {
        await fs.writeFile(filePath, "# no workflow yet\n", "utf8");
        assert.strictEqual(await parser.parsePromptFile(filePath), null);
        assert.ok(parser.lastParseError);
        assert.ok(
          !parser.lastParseError.message.includes("expected a document")
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("should parse .prompt.md file as single prompt", async () => {
      const filePath = path.join(fixturesPath, "simple.prompt.md");
      const result = await parser.parsePromptFile(filePath);

      assert.ok(result, "Result should not be null");
      assert.ok(result.steps, "Should have prompts array");
      assert.strictEqual(result.steps.length, 1);
      assert.ok(
        (result.steps[0] as PromptStep).prompt.includes(
          "simple markdown prompt"
        )
      );
    });

    test("should trim whitespace from prompt text", async () => {
      const filePath = path.join(fixturesPath, "simple.prompt.md");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      // Should be trimmed - no leading/trailing whitespace
      const promptText = (result.steps[0] as PromptStep).prompt;
      assert.strictEqual(promptText, promptText.trim());
    });

    test("should return null for empty file", async () => {
      const filePath = path.join(fixturesPath, "empty.prompt.md");
      const result = await parser.parsePromptFile(filePath);

      // Empty file should return null (error case)
      assert.strictEqual(result, null);
    });

    test("should preserve newlines in prompt content", async () => {
      const filePath = path.join(fixturesPath, "simple.prompt.md");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      // The fixture has multiple lines
      assert.ok(result.steps[0].prompt.includes("\n"));
    });

    test("should not have endCondition for markdown files", async () => {
      const filePath = path.join(fixturesPath, "simple.prompt.md");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      assert.strictEqual(result.steps[0].endCondition, undefined);
    });
  });

  suite("looksLikeFilePath - Heuristic Detection", () => {
    // These test the private method behavior through parsing
    // We can test indirectly by checking what the parser does with different prompt values

    test("should recognize ./relative/path.prompt.md as file path", async () => {
      // Test via the with-file-reference.json fixture
      const filePath = path.join(fixturesPath, "with-file-reference.json");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      // The authored lone path is retained for just-in-time resolution.
      assert.strictEqual(
        (result.steps[0] as PromptStep).prompt,
        "./external-prompt.prompt.md"
      );
    });

    test("should preserve prompt text as-is when not a file path", async () => {
      // The single.ctrlyoke.json contains a regular prompt - it should be preserved
      const filePath = path.join(fixturesPath, "single.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      // The prompt text should be preserved as-is, not treated as a file path
      assert.ok(result.steps[0].prompt.includes("Explain this code"));
    });
  });

  suite("File Path Resolution Order", () => {
    test("should resolve paths relative to prompt file directory", async () => {
      const filePath = path.join(fixturesPath, "with-file-reference.json");
      const result = await parser.parsePromptFile(filePath);

      assertValidResult(result);
      // The external-prompt.prompt.md is validated relative to the definition,
      // but the authored path remains the persisted prompt value.
      assert.strictEqual(
        (result.steps[0] as PromptStep).prompt,
        "./external-prompt.prompt.md"
      );
    });

    test("should reject an intentional missing prompt-file reference", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-missing-reference-")
      );
      const filePath = path.join(tempDir, "workflow.ctrlyoke.json");
      try {
        await fs.writeFile(
          filePath,
          JSON.stringify({ prompt: "./missing.prompt.md" }),
          "utf8"
        );
        assert.strictEqual(await parser.parsePromptFile(filePath), null);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    test("retains a variable-backed prompt-file reference for runtime resolution", async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "ctrlyoke-parser-variable-reference-")
      );
      const filePath = path.join(tempDir, "workflow.ctrlyoke.json");
      try {
        await fs.writeFile(
          filePath,
          JSON.stringify({
            vars: { promptName: "current" },
            prompt: "./{{promptName}}.prompt.md",
          }),
          "utf8"
        );
        const result = await parser.parsePromptFile(filePath);
        assertValidResult(result);
        assert.strictEqual(
          (result.steps[0] as PromptStep).prompt,
          "./{{promptName}}.prompt.md"
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  suite("validateWorkflowSteps", () => {
    test("should validate valid prompt items", () => {
      const items = [{ prompt: "First prompt" }, { prompt: "Second prompt" }];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test("warns without invalidating when a comparison has no value to apply", () => {
      const result = parser.validateWorkflowSteps(
        [
          {
            prompt: "Test",
            endCondition: { script: "check.js", compareSource: "stdout" },
          },
          { type: "script", script: "npm test", operator: "contains" },
          { prompt: "Fine", endCondition: { script: "check.js" } },
        ] as WorkflowStep[],
        {
          finalStep: {
            prompt: "Wrap up",
            preCondition: { script: "gate.js", operator: "gte" },
          } as WorkflowStep,
        }
      );

      assert.strictEqual(result.valid, true, "a warning never blocks the load");
      assert.strictEqual(result.errors.length, 0);
      assert.deepStrictEqual(
        result.warnings.map((warning) => warning.propertyPointer),
        [
          "/steps/0/endCondition/expected",
          "/steps/1/expected",
          "/finalStep/preCondition/expected",
        ],
        "the third step's bare endCondition is the documented default, not a warning"
      );
      assert.ok(
        result.warnings.every(
          (warning) =>
            warning.code ===
            WORKFLOW_VALIDATION_WARNING_CODES.SCRIPT_COMPARISON_INCOMPLETE
        )
      );
      assert.match(result.warnings[0].message, /^Step 1: /u);
      assert.match(result.warnings[2].message, /^Final step: /u);
    });

    test("should reject empty prompts array", () => {
      const result = parser.validateWorkflowSteps([]);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("No steps found")));
    });

    test("should accept an empty steps array when a finalStep is present", () => {
      const result = parser.validateWorkflowSteps([], {
        finalStep: { prompt: "Orchestrate the work" },
      });
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test("should still validate queued steps alongside a finalStep", () => {
      const result = parser.validateWorkflowSteps([{ prompt: "  " }], {
        finalStep: { prompt: "Orchestrate the work" },
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("Empty prompt")));
    });

    test("should reject prompts with empty text", () => {
      const items = [{ prompt: "" }, { prompt: "Valid" }];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("Empty prompt")));
    });

    test("should reject prompts with only whitespace", () => {
      const items = [{ prompt: "   " }];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, false);
    });

    test("should validate endCondition when present", () => {
      const items = [
        {
          prompt: "Test",
          endCondition: {
            script: "test.py",
            expected: "true",
          },
        },
      ];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, true);
    });

    test("should reject endCondition missing script", () => {
      const items = [
        {
          prompt: "Test",
          endCondition: {
            expected: "true",
          } as any,
        },
      ];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("script")));
    });

    test("should accept an endCondition with no comparison value", () => {
      // No `expected` means "pass when the script exits 0".
      const items = [
        {
          prompt: "Test",
          endCondition: {
            script: "test.py",
          } as any,
        },
      ];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, true);
    });

    test("should reject the renamed `returns` key", () => {
      const items = [
        {
          prompt: "Test",
          endCondition: {
            script: "test.py",
            returns: "true",
          } as any,
        },
      ];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("expected")));
    });
  });

  suite("Error Handling", () => {
    test("should handle file read errors gracefully", async () => {
      const nonexistentPath = path.join(
        fixturesPath,
        "does-not-exist.prompt.json"
      );
      const result = await parser.parsePromptFile(nonexistentPath);
      assert.strictEqual(result, null);
    });

    test("should handle directory instead of file", async () => {
      const result = await parser.parsePromptFile(fixturesPath);
      assert.strictEqual(result, null);
    });
  });

  suite("isPromptFile Detection", () => {
    // Test the isPromptFile method indirectly through expected behavior
    test("should accept .ctrlyoke.json files", async () => {
      const filePath = path.join(fixturesPath, "single.ctrlyoke.json");
      const result = await parser.parsePromptFile(filePath);
      assert.ok(result, "Should parse .ctrlyoke.json files");
    });

    test("should accept .ctrlyoke.yaml files", async () => {
      const filePath = path.join(fixturesPath, "single.ctrlyoke.yaml");
      const result = await parser.parsePromptFile(filePath);
      assert.ok(result, "Should parse .ctrlyoke.yaml files");
    });

    test("should accept .prompt.md files", async () => {
      const filePath = path.join(fixturesPath, "simple.prompt.md");
      const result = await parser.parsePromptFile(filePath);
      assert.ok(result, "Should parse .prompt.md files");
    });
  });
});
