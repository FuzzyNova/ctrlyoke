import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import workflowSchema from "../../../../../schemas/workflow-schema.json";
import type { EndCondition, PreCondition } from "@root/types/CtrlYokeTypes";
import { END_CONDITION_DEFAULTS } from "@store/editorStore";
import { buildPropertyUpdateValues } from "@utils/promptPropertyValues";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validateWorkflow = ajv.compile(workflowSchema);

/** Assert the editor's save payload is a schema-valid step and final step. */
function expectSchemaValid(properties: Record<string, unknown>): void {
  const workflow = {
    steps: [{ prompt: "Fix the bug.", ...properties }],
    finalStep: { prompt: "Hunt for bugs.", ...properties },
  };
  expect(
    validateWorkflow(workflow),
    JSON.stringify(validateWorkflow.errors)
  ).toBe(true);
}

describe("buildPropertyUpdateValues conditions", () => {
  // The shape of the bug-hunt workflow's `committed` condition: an operator
  // comparison with no `expected`, and none of the removed `returns` field.
  const endCondition: EndCondition = {
    script: "git status --porcelain 2>&1",
    compareSource: "stdout",
    operator: "isEmpty",
    maxRetries: 2,
    retryPrompt: "You left uncommitted changes.",
  };
  const preCondition: PreCondition = {
    script: "git status --porcelain 2>&1",
    compareSource: "stdout",
    operator: "isEmpty",
    onFail: "stopWorkflow",
  };

  it("keeps schema-valid pre- and end conditions on save", () => {
    const { properties, clearProperties } = buildPropertyUpdateValues(
      { endCondition, preCondition },
      { includeNullsForDefaults: true }
    );

    expect(properties.endCondition).toEqual(endCondition);
    expect(properties.preCondition).toEqual(preCondition);
    expect(clearProperties).not.toContain("endCondition");
    expect(clearProperties).not.toContain("preCondition");
    expectSchemaValid(properties);
  });

  it("keeps an end condition that passes on exit code 0", () => {
    const exitZero: EndCondition = { script: "npm test" };
    const { properties } = buildPropertyUpdateValues({
      endCondition: exitZero,
    });

    expect(properties.endCondition).toEqual(exitZero);
    expectSchemaValid(properties);
  });

  it("sends None for an end condition with no script", () => {
    const { properties } = buildPropertyUpdateValues({
      endCondition: { script: "   " },
    });

    expect(properties.endCondition).toBeNull();
    expectSchemaValid(properties);
  });

  it("seeds a new custom end condition with only schema fields", () => {
    const { properties } = buildPropertyUpdateValues({
      endCondition: { ...END_CONDITION_DEFAULTS, script: "npm test" },
    });

    expect(properties.endCondition).not.toBeNull();
    expectSchemaValid(properties);
  });
});
