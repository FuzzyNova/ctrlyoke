import * as assert from "assert";
import { VarSubstitutor } from "../../utils/VarSubstitutor";
import type { ResolvedProperties } from "../../utils/PropertyResolver";
import { HARNESS_IDS } from "../../types/DashboardConstants";

suite("VarSubstitutor Tests", () => {
  suite("substitute", () => {
    test("replaces a single placeholder", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("Hello {{name}}!", { name: "World" }),
        "Hello World!"
      );
    });

    test("replaces multiple placeholders in one string", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("{{greeting}} {{name}}", {
          greeting: "Hi",
          name: "Nathan",
        }),
        "Hi Nathan"
      );
    });

    test("replaces the same placeholder multiple times", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("{{x}} + {{x}} = 2{{x}}", { x: "1" }),
        "1 + 1 = 21"
      );
    });

    test("returns the string unchanged when no placeholders present", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("no placeholders here", { key: "value" }),
        "no placeholders here"
      );
    });

    test("throws on unresolved placeholder when vars is empty", () => {
      assert.throws(
        () => VarSubstitutor.substitute("no vars {{key}}", {}),
        /Unresolved variable.*key/
      );
    });

    test("throws on unresolved placeholder", () => {
      assert.throws(
        () => VarSubstitutor.substitute("Hello {{missing}}", { other: "x" }),
        /Unresolved variable.*missing.*--var missing=/
      );
    });

    test("throws listing the exact missing key", () => {
      try {
        VarSubstitutor.substitute("path = {{repoPath}}", {});
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("repoPath"),
          `Expected 'repoPath' in error message: ${err.message}`
        );
      }
    });

    test("handles empty string value", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("prefix{{empty}}suffix", { empty: "" }),
        "prefixsuffix"
      );
    });

    test("handles value containing special regex chars", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("{{path}}", { path: "C:\\Users\\foo" }),
        "C:\\Users\\foo"
      );
    });
  });

  suite("hasPlaceholders", () => {
    test("returns true when placeholder present", () => {
      assert.strictEqual(VarSubstitutor.hasPlaceholders("{{key}}"), true);
    });

    test("returns false when no placeholder", () => {
      assert.strictEqual(VarSubstitutor.hasPlaceholders("no vars"), false);
    });
  });

  suite("applyToPromptText", () => {
    test("substitutes in prompt text", () => {
      assert.strictEqual(
        VarSubstitutor.applyToPromptText("Scan the repo at {{repoPath}}", {
          repoPath: "/home/user/myrepo",
        }),
        "Scan the repo at /home/user/myrepo"
      );
    });

    test("returns original when vars is empty", () => {
      const text = "Scan the repo at {{repoPath}}";
      assert.strictEqual(VarSubstitutor.applyToPromptText(text, {}), text);
    });

    test("returns original when text is empty string", () => {
      assert.strictEqual(VarSubstitutor.applyToPromptText("", { x: "y" }), "");
    });
  });

  suite("applyToResolvedProperties", () => {
    function makeProps(
      overrides: Partial<ResolvedProperties> = {}
    ): ResolvedProperties {
      return {
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "claude-sonnet-4.6",
        executionMode: "headless",
        resumeSession: false,
        mcpServers: null,
        hooks: null,
        toolPermissions: null,
        ...overrides,
      };
    }

    test("substitutes model", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({ model: "{{model}}" }),
        { model: "claude-opus-4.6" }
      );
      assert.strictEqual(result.model, "claude-opus-4.6");
    });

    test("substitutes additionalArgs", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({ additionalArgs: "--effort {{effort}}" }),
        { effort: "high" }
      );
      assert.strictEqual(result.additionalArgs, "--effort high");
    });

    test("substitutes hook commands", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({
          hooks: [
            { event: "stop", command: "node record.js stop {{harness}}" },
            {
              event: "sessionStart",
              command: "node record.js start {{harness}}",
            },
          ],
        }),
        { harness: "claude-cli" }
      );
      assert.strictEqual(
        result.hooks![0].command,
        "node record.js stop claude-cli"
      );
      assert.strictEqual(
        result.hooks![1].command,
        "node record.js start claude-cli"
      );
    });

    test("substitutes endCondition script path", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({
          endCondition: {
            script: "scripts/check-{{env}}.sh",
            returns: "true",
          },
        }),
        { env: "prod" }
      );
      assert.strictEqual(result.endCondition!.script, "scripts/check-prod.sh");
    });

    test("substitutes endCondition retryPrompt", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({
          endCondition: {
            script: "check.sh",
            returns: "true",
            retryPrompt: "Fix issues in {{repoPath}}",
          },
        }),
        { repoPath: "/home/user/repo" }
      );
      assert.strictEqual(
        result.endCondition!.retryPrompt,
        "Fix issues in /home/user/repo"
      );
    });

    test("returns same object reference when vars is empty", () => {
      const props = makeProps();
      const result = VarSubstitutor.applyToResolvedProperties(props, {});
      assert.strictEqual(result, props);
    });

    test("does not mutate the input object", () => {
      const props = makeProps({ model: "{{model}}" });
      VarSubstitutor.applyToResolvedProperties(props, { model: "opus" });
      assert.strictEqual(props.model, "{{model}}");
    });

    test("preserves null hooks as null", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({ hooks: null }),
        { x: "y" }
      );
      assert.strictEqual(result.hooks, null);
    });

    test("preserves undefined endCondition as undefined", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({ endCondition: undefined }),
        { x: "y" }
      );
      assert.strictEqual(result.endCondition, undefined);
    });

    test("throws on missing var in model when other vars are present", () => {
      // When vars is non-empty, substitution runs and missing keys throw.
      assert.throws(
        () =>
          VarSubstitutor.applyToResolvedProperties(
            makeProps({ model: "{{missing}}" }),
            { other: "value" }
          ),
        /missing/
      );
    });
  });
});
