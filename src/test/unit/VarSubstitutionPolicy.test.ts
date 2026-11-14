import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  VarSubstitutionValidationError,
  VarSubstitutor,
} from "../../utils/VarSubstitutor";
import { validateWorkflowSchemaValue } from "../../utils/WorkflowSchemaValidation";
import type {
  PromptStep,
  ScriptStep,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../utils/SettingsPropertyResolver";
import {
  VAR_SUBSTITUTION_EXCLUDED_FIELDS,
  VAR_SUBSTITUTION_POLICY,
  VAR_SUBSTITUTION_PHASES,
  VAR_SUBSTITUTION_KINDS,
  VAR_SUBSTITUTION_UNRESOLVED,
  type VarSubstitutionPolicyEntry,
} from "../../utils/VarSubstitutionPolicy";

const POLICY_ENTRIES = Object.entries(VAR_SUBSTITUTION_POLICY) as Array<
  [string, VarSubstitutionPolicyEntry]
>;

suite("VarSubstitutionPolicy documentation", () => {
  test("dispatch text policy substitutes supported step fields on a copy", () => {
    const authored = {
      type: "script" as const,
      name: "{{label}}",
      script: "echo hi",
      shell: "{{shell}}",
      expected: "{{expected}}",
      agent: "{{agent}}",
      skills: ["{{skill}}"],
      sessionId: "{{session}}",
      priorContext: { workflow: "{{workflow}}", run: "{{run}}" },
    };
    const resolved = VarSubstitutor.substituteStepView(
      authored as unknown as ScriptStep,
      {
        label: "Build",
        shell: "bash",
        expected: "ok",
        agent: "reviewer",
        skill: "lint",
        session: "abc",
        workflow: "tasks",
        run: "12",
      },
      "dispatch"
    ) as ScriptStep & Record<string, unknown>;
    assert.deepStrictEqual(authored.name, "{{label}}");
    assert.strictEqual(resolved.name, "Build");
    assert.strictEqual(resolved.expected, "ok");
    assert.strictEqual(resolved.shell, "bash");
    assert.strictEqual(resolved.agent, "reviewer");
    assert.deepStrictEqual(resolved.skills, ["lint"]);
    assert.strictEqual(resolved.sessionId, "abc");
    assert.deepStrictEqual(resolved.priorContext, {
      workflow: "tasks",
      run: 12,
    });
  });

  test("coerces and validates dispatch value fields", () => {
    const resolved = VarSubstitutor.substituteStepView(
      {
        type: "script" as const,
        script: "echo hi",
        executionMode: "{{mode}}",
        timeoutSec: "{{timeout}}",
        ignoreCase: "{{case}}",
        endCondition: {
          script: "echo ok",
          maxRetries: "{{retries}}",
        },
      } as unknown as WorkflowStep,
      { mode: "headless", timeout: "30", case: "true", retries: "2" },
      "dispatch"
    ) as WorkflowStep & Record<string, any>;
    assert.strictEqual(resolved.executionMode, "headless");
    assert.strictEqual(resolved.timeoutSec, 30);
    assert.strictEqual(resolved.ignoreCase, true);
    assert.strictEqual(resolved.endCondition?.maxRetries, 2);
    assert.throws(
      () =>
        VarSubstitutor.substituteStepView(
          {
            type: "script",
            script: "echo hi",
            timeoutSec: "{{timeout}}",
          } as unknown as WorkflowStep,
          { timeout: "soon" },
          "dispatch",
          2
        ),
      (error: Error) =>
        error instanceof VarSubstitutionValidationError &&
        error.message ===
          'steps[2].timeoutSec: variable "timeout" is "soon", expected a number greater than 0.'
    );
  });

  test("keeps numeric expected and session references numeric", () => {
    const resolved = VarSubstitutor.substituteStepView(
      {
        type: "script",
        script: "echo hi",
        expected: 3,
        sessionId: 1,
      } as unknown as ScriptStep,
      { expected: "4", session: "abc" },
      "dispatch"
    ) as ScriptStep & Record<string, unknown>;
    assert.strictEqual(resolved.expected, 3);
    assert.strictEqual(resolved.sessionId, 1);
  });

  test("reports unresolved strict fields with their indexed schema path", () => {
    assert.throws(
      () =>
        VarSubstitutor.substituteStepView(
          {
            type: "script",
            script: "echo hi",
            skills: ["{{missing}}"],
          } as unknown as ScriptStep,
          {},
          "dispatch"
        ),
      /steps\[0\]\.skills\[0\].*missing/
    );
  });

  test("worktree selectors are strict run-start text fields", () => {
    for (const field of [
      "worktree.branch",
      "worktree.base",
      "worktree.directory",
      "defaults.worktree.branch",
      "defaults.worktree.base",
      "defaults.worktree.directory",
    ] as const) {
      const { phase, kind, fencedCodeProtected, unresolved } =
        VAR_SUBSTITUTION_POLICY[field];
      assert.deepStrictEqual(
        { phase, kind, fencedCodeProtected, unresolved },
        {
          phase: VAR_SUBSTITUTION_PHASES.RUN_START,
          kind: VAR_SUBSTITUTION_KINDS.TEXT,
          fencedCodeProtected: false,
          unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
        }
      );
    }
  });
  const repoPath = (...parts: string[]) =>
    path.resolve(__dirname, "../../..", ...parts);

  test("varsConfig schema description names every substituted policy field", () => {
    const schema = JSON.parse(
      fs.readFileSync(repoPath("schemas", "workflow-schema.json"), "utf8")
    ) as { $defs: { varsConfig: { description: string } } };
    const description = schema.$defs.varsConfig.description;

    for (const field of Object.keys(VAR_SUBSTITUTION_POLICY)) {
      assert.ok(
        description.includes(field),
        `schema description omits ${field}`
      );
    }
  });

  test("value entries cover exactly the schema locations accepting varPlaceholder", () => {
    const schema = JSON.parse(
      fs.readFileSync(repoPath("schemas", "workflow-schema.json"), "utf8")
    ) as Record<string, unknown>;
    const VAR_PLACEHOLDER_REF = "#/$defs/varPlaceholder";
    const PLACEHOLDER_REFS = new Set([
      VAR_PLACEHOLDER_REF,
      "#/$defs/templatePlaceholder",
    ]);
    type Node = { [key: string]: any };
    const at = (pointer: string): Node =>
      pointer
        .split("/")
        .slice(1)
        .reduce<any>((node, key) => node?.[key], schema);
    const acceptsVar = (node: Node | undefined): boolean =>
      Array.isArray(node?.oneOf) &&
      node.oneOf.some((choice: Node) => choice.$ref === VAR_PLACEHOLDER_REF);
    const locations: string[] = [];
    const collect = (node: unknown, pointer: string): void => {
      if (!node || typeof node !== "object") return;
      if (acceptsVar(node as Node)) locations.push(pointer);
      for (const [key, child] of Object.entries(node))
        collect(child, `${pointer}/${key}`);
    };
    collect(schema, "");
    assert.ok(locations.length > 0);
    // The original sub-schema: the one non-placeholder branch, following a
    // $ref to its target (and through it when the target accepts placeholders too).
    const original = (location: string): string => {
      const branches = (at(location).oneOf as Node[])
        .map((choice, index) => ({
          choice,
          pointer: `${location}/oneOf/${index}`,
        }))
        .filter(({ choice }) => !PLACEHOLDER_REFS.has(choice.$ref));
      assert.strictEqual(branches.length, 1, `${location} original branch`);
      const { choice, pointer } = branches[0]!;
      if (typeof choice.$ref !== "string") return pointer;
      const target = choice.$ref.slice(1);
      return acceptsVar(at(target)) ? original(target) : target;
    };
    const withoutAnnotations = (node: Node): string =>
      JSON.stringify(node, (key, value) =>
        key === "description" || key === "default" ? undefined : value
      );
    const tableSchemas = new Set(
      POLICY_ENTRIES.flatMap(([, entry]) =>
        entry.kind === VAR_SUBSTITUTION_KINDS.VALUE ? [entry.schema] : []
      )
    );
    const schemaOriginals = new Set(locations.map(original));
    for (const location of locations) {
      const pointer = original(location);
      assert.ok(
        tableSchemas.has(pointer) ||
          [...tableSchemas].some(
            (tablePointer) =>
              withoutAnnotations(at(tablePointer)) ===
              withoutAnnotations(at(pointer))
          ),
        `${location} accepts varPlaceholder but no value entry validates against ${pointer}`
      );
    }
    for (const [field, entry] of POLICY_ENTRIES) {
      if (entry.kind !== VAR_SUBSTITUTION_KINDS.VALUE) continue;
      assert.ok(
        schemaOriginals.has(entry.schema),
        `${field} validates against ${entry.schema}, which no varPlaceholder location names`
      );
      assert.strictEqual(
        validateWorkflowSchemaValue(entry.schema, "{{name}}"),
        false,
        `${field} schema must not accept a placeholder`
      );
    }
    assert.ok(
      !acceptsVar(at("/$defs/executionProperties/properties/sandboxMode"))
    );
  });

  test("each view path is owned by one entry, and excluded fields have none", () => {
    const seen = new Map<string, string>();
    for (const [field, entry] of POLICY_ENTRIES) {
      const key = `${entry.view}:${entry.path.join(".")}`;
      assert.ok(!seen.has(key), `${field} and ${seen.get(key)} share ${key}`);
      seen.set(key, field);
    }
    for (const { path: excluded } of VAR_SUBSTITUTION_EXCLUDED_FIELDS)
      assert.ok(
        !POLICY_ENTRIES.some(([, entry]) => entry.path.includes(excluded)),
        `${excluded} is excluded but has a policy entry`
      );
  });

  test("walker: text fields substitute, keep advisory placeholders, and honor fences", () => {
    const props = {
      model: "{{model}}",
      additionalArgs: "--x {{missing}}",
      hooks: null,
    } as unknown as ResolvedProperties;
    const resolved = VarSubstitutor.applyToResolvedProperties(props, {
      model: "opus",
    });
    assert.strictEqual(resolved.model, "opus");
    assert.strictEqual(resolved.additionalArgs, "--x {{missing}}");
    assert.strictEqual(props.model, "{{model}}");

    const fenced = "```\n{{x}}\n```\n{{x}}";
    assert.strictEqual(
      VarSubstitutor.applyToPromptText(fenced, { x: "y" }),
      "```\n{{x}}\n```\ny"
    );
    const script = VarSubstitutor.applyToScriptStep(
      { type: "script", script: fenced } as ScriptStep,
      { x: "y" }
    );
    assert.strictEqual(script.script, "```\ny\n```\ny");
  });

  test("walker: returns the same object when no field changes", () => {
    const step = {
      prompt: "plain",
      name: "Build",
      endCondition: { script: "echo ok", maxRetries: 2 },
    } as PromptStep;
    assert.strictEqual(
      VarSubstitutor.substituteStepView(step, { x: "y" }, "dispatch"),
      step
    );
    const props = {
      model: "opus",
      hooks: null,
    } as unknown as ResolvedProperties;
    assert.strictEqual(
      VarSubstitutor.applyToResolvedProperties(props, {}),
      props
    );
  });

  test("walker: value fields reject partial and unresolved placeholders", () => {
    const step = (value: string) =>
      ({
        prompt: "x",
        errorBehavior: { onError: value },
      }) as unknown as PromptStep;
    assert.throws(
      () =>
        VarSubstitutor.substituteStepView(
          step("re{{x}}"),
          { x: "try" },
          "dispatch",
          1
        ),
      (error: Error) =>
        error instanceof VarSubstitutionValidationError &&
        error.message.startsWith("steps[1].errorBehavior.onError:")
    );
    assert.throws(
      () =>
        VarSubstitutor.substituteStepView(step("{{x}}"), {}, "dispatch", -1),
      (error: Error) =>
        error instanceof VarSubstitutionValidationError &&
        error.message ===
          'finalStep.errorBehavior.onError: variable "x" in "{{x}}" is not defined.'
    );
    assert.throws(
      () =>
        VarSubstitutor.substituteStepView(
          step("{{x}}"),
          { x: "never" },
          "dispatch"
        ),
      /expected one of "stopWorkflow", "retry", "retryPhase", "continue"\.$/
    );
    const resolved = VarSubstitutor.substituteStepView(
      step("{{x}}"),
      { x: "continue" },
      "dispatch"
    ) as PromptStep;
    assert.strictEqual(resolved.errorBehavior?.onError, "continue");
  });

  test("walker: priorContext.run post-validator rejects other text", () => {
    assert.throws(
      () =>
        VarSubstitutor.substituteStepView(
          {
            prompt: "x",
            priorContext: { workflow: "w", run: "{{run}}" },
          } as unknown as PromptStep,
          { run: "latest" },
          "dispatch"
        ),
      (error: Error) =>
        error instanceof VarSubstitutionValidationError &&
        error.message ===
          'steps[0].priorContext.run: variable "run" is "latest", expected an integer or run reference.'
    );
  });

  test("variables docs name every substituted policy field", () => {
    const docs = fs.readFileSync(
      repoPath("docs", "workflows", "variables.md"),
      "utf8"
    );

    for (const field of Object.keys(VAR_SUBSTITUTION_POLICY)) {
      assert.ok(docs.includes(`\`${field}\``), `variables docs omit ${field}`);
    }
  });
});
