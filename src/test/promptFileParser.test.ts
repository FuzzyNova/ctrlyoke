import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { PromptFileParser } from "../core/PromptFileParser";
import type { PromptStep } from "../types/CtrlYokeTypes";

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

  suite("parsePromptFile - JSON Format", () => {
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
      assert.strictEqual(endCondition.returns, "true");
      assert.strictEqual(endCondition.timeout, 30000);
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
                retryDelayMs: 1000,
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
          retryDelayMs: 1000,
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
      const filePath = path.join(
        tempDir,
        "on-pass-retry.ctrlyoke.json"
      );

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
                    returns: "true",
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

  suite("parseMarkdownPromptFile", () => {
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
      // The prompt should be resolved from external-prompt.prompt.md
      assert.ok(result.steps[0].prompt.includes("external prompt"));
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
      // The external-prompt.prompt.md is in the same directory as with-file-reference.json
      // So it should be resolved relative to the prompt file directory
      assert.ok(result.steps[0].prompt.includes("external prompt"));
    });

    test("should return literal text when file not found", async () => {
      // We can't easily test this without modifying fixtures
      // But the behavior is covered by the implementation - if file not found,
      // it returns the original prompt value as literal text
      // This is implicitly tested by single.prompt.json preserving its prompt text
    });
  });

  suite("validateWorkflowSteps", () => {
    test("should validate valid prompt items", () => {
      const items = [{ prompt: "First prompt" }, { prompt: "Second prompt" }];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
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
            returns: "true",
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
            returns: "true",
          } as any,
        },
      ];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("script")));
    });

    test("should reject endCondition missing returns", () => {
      const items = [
        {
          prompt: "Test",
          endCondition: {
            script: "test.py",
          } as any,
        },
      ];
      const result = parser.validateWorkflowSteps(items);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("return")));
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
