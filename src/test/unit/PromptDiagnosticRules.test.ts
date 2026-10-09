import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getConditionOutputDiagnostics,
  getPriorContextDiagnostics,
  getPromptDiagnostics,
  getReferenceDiagnostics,
  getUndefinedVariableDiagnostics,
  type ContextReferenceResolver,
  type PromptDiagnosticContext,
} from "../../utils/PromptDiagnosticRules";
import {
  PROMPT_DIAGNOSTIC_CODES,
  PROMPT_DIAGNOSTIC_FIELDS,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  RETRY_PROMPT_PLACEHOLDERS,
} from "../../types/DashboardConstants";

const baseContext: PromptDiagnosticContext = {
  stepIndex: 3,
  stepCount: 3,
  hasFinalStep: true,
  hasPreCondition: true,
  hasEndCondition: true,
  field: PROMPT_DIAGNOSTIC_FIELDS.PROMPT,
};

function context(
  overrides: Partial<PromptDiagnosticContext>
): PromptDiagnosticContext {
  return { ...baseContext, ...overrides };
}

function summarize(
  text: string,
  diagnostics: ReturnType<typeof getPromptDiagnostics>
) {
  return diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    text: text.slice(d.from, d.to),
  }));
}

suite("PromptDiagnosticRules", () => {
  suite("prior context", () => {
    test("reports $previous and $all when there are no prior steps", () => {
      for (const token of ["$previous", "$all"]) {
        const diagnostics = getPriorContextDiagnostics(
          `Use ${token}`,
          context({ stepCount: 0 })
        );
        assert.deepStrictEqual(
          summarize(`Use ${token}`, diagnostics),
          [
            {
              code: PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_NO_PRIOR_STEPS,
              severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
              text: token,
            },
          ],
          token
        );
      }
    });

    test("reports an over-large $previous:N as information, not an error", () => {
      const text = "$previous:5";
      const [diagnostic] = getPriorContextDiagnostics(
        text,
        context({ stepCount: 1 })
      );
      assert.strictEqual(
        diagnostic.code,
        PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_COUNT_CAPPED
      );
      assert.strictEqual(
        diagnostic.severity,
        COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO
      );
      assert.strictEqual(
        diagnostic.message,
        "Only 1 prior step is available before this step — $previous:5 will include at most 1"
      );
    });

    test("pluralizes the capped message", () => {
      const [diagnostic] = getPriorContextDiagnostics(
        "$previous:5",
        context({ stepCount: 2 })
      );
      assert.ok(diagnostic.message.startsWith("Only 2 prior steps are"));
    });

    test("reports $finalStep and $allFinalStep without a final step", () => {
      for (const token of ["$finalStep", "$allFinalStep"]) {
        assert.deepStrictEqual(
          summarize(
            token,
            getPriorContextDiagnostics(token, context({ hasFinalStep: false }))
          ),
          [
            {
              code: PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_NO_FINAL_STEP,
              severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
              text: token,
            },
          ],
          token
        );
        assert.deepStrictEqual(
          getPriorContextDiagnostics(token, context({ hasFinalStep: true })),
          []
        );
      }
    });

    test("reports $step:N that does not exist", () => {
      const [single] = getPriorContextDiagnostics("$step:9", baseContext);
      assert.strictEqual(
        single.code,
        PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_STEP_MISSING
      );
      assert.strictEqual(
        single.message,
        "Prior context not found — step 9 does not exist"
      );
      const [range] = getPriorContextDiagnostics("$step:8-9", baseContext);
      assert.ok(range.message.includes("do not exist"));
      assert.deepStrictEqual(
        getPriorContextDiagnostics("$step:3", baseContext),
        []
      );
    });

    test("ignores prior-context refs inside inline code and fences", () => {
      assert.deepStrictEqual(
        getPriorContextDiagnostics("`$step:9`", baseContext),
        []
      );
      assert.deepStrictEqual(
        getPriorContextDiagnostics("```\n$step:9\n```", baseContext),
        []
      );
    });

    test("maps ranges onto the whole text", () => {
      const text = "line one\nthen $step:9 here";
      const [diagnostic] = getPriorContextDiagnostics(text, baseContext);
      assert.strictEqual(text.slice(diagnostic.from, diagnostic.to), "$step:9");
    });
  });

  suite("condition output", () => {
    test("reports $preCondition: when the step has no pre-condition", () => {
      const text = "$preCondition:stdout";
      const [diagnostic] = getConditionOutputDiagnostics(
        text,
        context({ hasPreCondition: false })
      );
      assert.strictEqual(
        diagnostic.code,
        PROMPT_DIAGNOSTIC_CODES.CONDITION_NO_PRE_CONDITION
      );
      assert.deepStrictEqual(
        getConditionOutputDiagnostics(text, baseContext),
        []
      );
    });

    test("allows $endCondition: only in the retry prompt", () => {
      const text = "$endCondition:stderr";
      const [diagnostic] = getConditionOutputDiagnostics(text, baseContext);
      assert.strictEqual(
        diagnostic.code,
        PROMPT_DIAGNOSTIC_CODES.CONDITION_END_CONDITION_OUTSIDE_RETRY
      );
      assert.deepStrictEqual(
        getConditionOutputDiagnostics(
          text,
          context({ field: PROMPT_DIAGNOSTIC_FIELDS.RETRY_PROMPT })
        ),
        []
      );
    });

    test("reports an unknown field and suggests the field it extends", () => {
      const [diagnostic] = getConditionOutputDiagnostics(
        "$preCondition:stdout2",
        baseContext
      );
      assert.strictEqual(
        diagnostic.code,
        PROMPT_DIAGNOSTIC_CODES.CONDITION_FIELD_UNKNOWN
      );
      assert.deepStrictEqual(diagnostic.replacements, ["$preCondition:stdout"]);
      assert.ok(
        diagnostic.message.endsWith(
          `Known fields: ${Object.values(RETRY_PROMPT_PLACEHOLDERS).join(", ")}.`
        )
      );
    });

    test("offers no replacement when nothing is close", () => {
      const [diagnostic] = getConditionOutputDiagnostics(
        "$preCondition:zzz",
        baseContext
      );
      assert.strictEqual(diagnostic.replacements, undefined);
      assert.ok(!diagnostic.message.includes("Did you mean"));
    });

    test("ignores condition refs inside code", () => {
      assert.deepStrictEqual(
        getConditionOutputDiagnostics(
          "```\n$endCondition:stdout\n```",
          context({ hasPreCondition: false })
        ),
        []
      );
    });
  });

  test("getPromptDiagnostics combines both synchronous families", () => {
    const text = "$step:9 and $preCondition:stdout";
    const diagnostics = getPromptDiagnostics(
      text,
      context({ hasPreCondition: false })
    );
    assert.deepStrictEqual(
      diagnostics.map((d) => d.code),
      [
        PROMPT_DIAGNOSTIC_CODES.PRIOR_CONTEXT_STEP_MISSING,
        PROMPT_DIAGNOSTIC_CODES.CONDITION_NO_PRE_CONDITION,
      ]
    );
  });

  suite("variables", () => {
    test("warns on a placeholder the vars don't define, naming the variable", () => {
      const text = "Use {{known}} and {{missing}}";
      const diagnostics = getUndefinedVariableDiagnostics(text, {
        known: "x",
      });
      assert.deepStrictEqual(
        diagnostics.map((d) => ({
          code: d.code,
          severity: d.severity,
          text: text.slice(d.from, d.to),
          variableName: d.variableName,
        })),
        [
          {
            code: PROMPT_DIAGNOSTIC_CODES.VARIABLE_UNDEFINED,
            severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
            text: "{{missing}}",
            variableName: "missing",
          },
        ]
      );
      assert.match(diagnostics[0].message, /--var missing=/);
    });

    test("flags inline-code placeholders but not fenced ones", () => {
      const text = "`{{inline}}`\n```\n{{fenced}}\n```";
      assert.deepStrictEqual(
        getUndefinedVariableDiagnostics(text, {}).map((d) => d.variableName),
        ["inline"]
      );
    });

    test("getPromptDiagnostics lints vars only when the context knows them", () => {
      const text = "{{missing}}";
      assert.deepStrictEqual(getPromptDiagnostics(text, baseContext), []);
      assert.deepStrictEqual(
        getPromptDiagnostics(text, context({ vars: {} })).map((d) => d.code),
        [PROMPT_DIAGNOSTIC_CODES.VARIABLE_UNDEFINED]
      );
    });
  });

  suite("references", () => {
    function resolver(existing: string[]): ContextReferenceResolver {
      return async (references) =>
        references.map((reference) =>
          existing.includes(reference.path ?? "")
            ? { id: reference.id, exists: true }
            : {
                id: reference.id,
                exists: false,
                message: "File not found",
                suggestions: ["@src/real.ts"],
              }
        );
    }

    test("reports an unresolved reference with detail and suggestions", async () => {
      const text = "See @src/missing.ts now";
      const [diagnostic] = await getReferenceDiagnostics(text, resolver([]));
      assert.strictEqual(
        diagnostic.code,
        PROMPT_DIAGNOSTIC_CODES.UNRESOLVED_REFERENCE
      );
      assert.strictEqual(diagnostic.message, "File not found");
      assert.strictEqual(diagnostic.detail, "@src/missing.ts");
      assert.deepStrictEqual(diagnostic.replacements, ["@src/real.ts"]);
      assert.strictEqual(
        text.slice(diagnostic.from, diagnostic.to),
        "@src/missing.ts"
      );
    });

    test("falls back to a generic message", async () => {
      const [diagnostic] = await getReferenceDiagnostics(
        "@src/missing.ts",
        async (references) =>
          references.map((reference) => ({ id: reference.id, exists: false }))
      );
      assert.strictEqual(diagnostic.message, "context not found");
    });

    test("warns about suppressed expansion only for existing targets in code", async () => {
      const real = resolver(["src/real.ts"]);
      for (const text of ["`@src/real.ts`", "```\n@src/real.ts\n```"]) {
        const diagnostics = await getReferenceDiagnostics(text, real);
        assert.deepStrictEqual(
          diagnostics.map((d) => d.code),
          [PROMPT_DIAGNOSTIC_CODES.EXPANSION_SUPPRESSED_IN_CODE],
          text
        );
      }
      assert.deepStrictEqual(
        await getReferenceDiagnostics("`@src/missing.ts`", resolver([])),
        []
      );
    });

    test("reports nothing for resolved references and skips the host without references", async () => {
      assert.deepStrictEqual(
        await getReferenceDiagnostics(
          "@src/real.ts",
          resolver(["src/real.ts"])
        ),
        []
      );
      let called = false;
      await getReferenceDiagnostics("no references here", async () => {
        called = true;
        return [];
      });
      assert.strictEqual(called, false);
    });
  });
});
