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

    test("leaves an unresolved placeholder literal when vars is empty", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("no vars {{key}}", {}),
        "no vars {{key}}"
      );
    });

    test("leaves an unresolved placeholder literal", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("Hello {{missing}}", { other: "x" }),
        "Hello {{missing}}"
      );
    });

    test("finds unique unresolved placeholders outside fenced blocks", () => {
      assert.deepStrictEqual(
        VarSubstitutor.findUnresolvedVariables(
          "{{missing}} {{missing}} {{resolved}}\n```\n{{fenced}}\n```",
          { resolved: "yes" }
        ),
        ["{{missing}}"]
      );
    });

    test("leaves fenced placeholders untouched", () => {
      const text = "```\n{{resolved}} {{missing}}\n```";
      assert.strictEqual(
        VarSubstitutor.substitute(text, { resolved: "yes" }),
        text
      );
    });

    test("substitutes placeholders inside inline code spans", () => {
      // Vars reach script text, where backticks are shell command
      // substitution, so only block fences keep a placeholder literal.
      assert.strictEqual(
        VarSubstitutor.substitute("echo `cat {{file}}`", { file: "a.txt" }),
        "echo `cat a.txt`"
      );
      assert.deepStrictEqual(
        VarSubstitutor.findUnresolvedVariables("`{{missing}}`", {}),
        ["{{missing}}"]
      );
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

    test("rejects variable values that contain a secret reference", () => {
      assert.throws(
        () =>
          VarSubstitutor.substitute("TOKEN={{value}}", {
            value: "${secret:GITHUB_TOKEN}",
          }),
        /cannot contain a managed secret reference/u
      );
    });

    test("rejects a secret reference spliced across placeholders", () => {
      assert.throws(
        () =>
          VarSubstitutor.substitute("X={{a}}{{b}}", {
            a: "${",
            b: "secret:GITHUB_TOKEN}",
          }),
        /Variable "a" cannot contain a managed secret reference/u
      );
    });

    test("rejects a secret reference spliced with authored text", () => {
      assert.throws(
        () =>
          VarSubstitutor.substitute("X=${{{b}}", {
            b: "secret:GITHUB_TOKEN}",
          }),
        /Variable "b" cannot contain a managed secret reference/u
      );
    });

    test("allows authored secret references alongside other substitutions", () => {
      assert.strictEqual(
        VarSubstitutor.substitute("X=${secret:NAME}; Y={{value}}", {
          value: "ordinary",
        }),
        "X=${secret:NAME}; Y=ordinary"
      );
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
            expected: "true",
          },
        }),
        { env: "prod" }
      );
      assert.strictEqual(result.endCondition!.script, "scripts/check-prod.sh");
    });

    test("substitutes endCondition retry prompts", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({
          endCondition: {
            script: "check.sh",
            expected: "true",
            retryPrompt: "Fix issues in {{repoPath}}",
            passRetryPrompt: "Keep working in {{repoPath}}",
          },
        }),
        { repoPath: "/home/user/repo" }
      );
      assert.strictEqual(
        result.endCondition!.retryPrompt,
        "Fix issues in /home/user/repo"
      );
      assert.strictEqual(
        result.endCondition!.passRetryPrompt,
        "Keep working in /home/user/repo"
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

    test("leaves missing vars literal in model when other vars are present", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({ model: "{{missing}}" }),
        { other: "value" }
      );
      assert.strictEqual(result.model, "{{missing}}");
    });

    test("substitutes preCondition script and env", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({
          preCondition: {
            script: "scripts/check-{{env}}.sh",
            env: { TARGET: "{{env}}" },
          },
        }),
        { env: "staging" }
      );
      assert.strictEqual(
        result.preCondition!.script,
        "scripts/check-staging.sh"
      );
      assert.strictEqual(result.preCondition!.env!.TARGET, "staging");
    });

    test("substitutes endCondition env", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({
          endCondition: {
            script: "check.sh",
            expected: "true",
            env: { TARGET: "{{env}}" },
          },
        }),
        { env: "prod" }
      );
      assert.strictEqual(result.endCondition!.env!.TARGET, "prod");
    });

    test("substitutes hook env", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({
          hooks: [
            {
              event: "stop",
              command: "notify.sh",
              env: { CHANNEL: "{{channel}}" },
            },
          ],
        }),
        { channel: "#deploys" }
      );
      assert.strictEqual(result.hooks![0].env!.CHANNEL, "#deploys");
    });

    test("preserves undefined preCondition as undefined", () => {
      const result = VarSubstitutor.applyToResolvedProperties(
        makeProps({ preCondition: undefined }),
        { x: "y" }
      );
      assert.strictEqual(result.preCondition, undefined);
    });
  });

  suite("applyToScriptStep", () => {
    test("substitutes script and env", () => {
      const result = VarSubstitutor.applyToScriptStep(
        {
          type: "script",
          script: "npm run {{task}}",
          env: { TOKEN: "{{token}}" },
        },
        { task: "deploy", token: "abc123" }
      );
      assert.strictEqual(result.script, "npm run deploy");
      assert.strictEqual(result.env!.TOKEN, "abc123");
    });

    test("returns same object reference when vars is empty", () => {
      const step = { type: "script" as const, script: "npm run {{task}}" };
      const result = VarSubstitutor.applyToScriptStep(step, {});
      assert.strictEqual(result, step);
    });

    test("does not mutate the input object", () => {
      const step = { type: "script" as const, script: "npm run {{task}}" };
      VarSubstitutor.applyToScriptStep(step, { task: "deploy" });
      assert.strictEqual(step.script, "npm run {{task}}");
    });

    test("preserves name, timeout, and other fields untouched", () => {
      const result = VarSubstitutor.applyToScriptStep(
        {
          type: "script",
          name: "Deploy",
          script: "npm run deploy",
          timeoutSec: 0.06,
          onPass: "continue",
          onFail: "stopWorkflow",
        },
        { x: "y" }
      );
      assert.strictEqual(result.name, "Deploy");
      assert.strictEqual(result.timeoutSec, 0.06);
      assert.strictEqual(result.onPass, "continue");
      assert.strictEqual(result.onFail, "stopWorkflow");
    });
  });
});
