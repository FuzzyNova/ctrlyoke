import { describe, it, expect } from "vitest";
import {
  getEndConditionValue,
  buildEndConditionFromValues,
  endConditionToFormValues,
  hasEndCondition,
  DEFAULT_END_CONDITION_VALUES,
} from "@utils/endCondition";

// ─────────────────────────────────────────────────────────────────────────────
// getEndConditionValue
// ─────────────────────────────────────────────────────────────────────────────

describe("getEndConditionValue", () => {
  it("returns the property value when present", () => {
    expect(getEndConditionValue({ script: "npm test", returns: "true" }, "script", "")).toBe("npm test");
  });

  it("returns defaultValue when property is absent", () => {
    expect(getEndConditionValue({ script: "npm test", returns: "true" }, "timeout", 30000)).toBe(30000);
  });

  it("returns defaultValue when endCondition is null", () => {
    expect(getEndConditionValue(null, "script", "default")).toBe("default");
  });

  it("returns defaultValue when endCondition is undefined", () => {
    expect(getEndConditionValue(undefined, "script", "default")).toBe("default");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hasEndCondition
// ─────────────────────────────────────────────────────────────────────────────

describe("hasEndCondition", () => {
  it("returns true for an end condition with a script", () => {
    expect(hasEndCondition({ script: "npm test", returns: "true" })).toBe(true);
  });

  it("returns false for null", () => {
    expect(hasEndCondition(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasEndCondition(undefined)).toBe(false);
  });

  it("returns false for an object with an empty script", () => {
    expect(hasEndCondition({ script: "", returns: "true" })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// endConditionToFormValues
// ─────────────────────────────────────────────────────────────────────────────

describe("endConditionToFormValues", () => {
  it("returns enabled=false with defaults when input is undefined (inherit)", () => {
    const form = endConditionToFormValues(undefined);
    expect(form.enabled).toBe(false);
    expect(form.script).toBe(DEFAULT_END_CONDITION_VALUES.END_SCRIPT);
    expect(form.returns).toBe(DEFAULT_END_CONDITION_VALUES.END_RETURNS);
  });

  it("returns enabled=true with empty fields when input is null (explicitly disabled)", () => {
    const form = endConditionToFormValues(null);
    expect(form.enabled).toBe(true);
    expect(form.script).toBe("");
    expect(form.returns).toBe("");
    expect(form.retryPrompt).toBe("");
  });

  it("returns enabled=true with values from the end condition object", () => {
    const ec = {
      script: "npm test",
      returns: "0",
      timeout: 5000,
      maxRetries: 3,
      retryPrompt: "Fix it",
    };
    const form = endConditionToFormValues(ec);
    expect(form.enabled).toBe(true);
    expect(form.script).toBe("npm test");
    expect(form.returns).toBe("0");
    expect(form.timeout).toBe("5000");
    expect(form.maxRetries).toBe("3");
    expect(form.retryPrompt).toBe("Fix it");
  });

  it("uses defaults for absent optional fields", () => {
    const form = endConditionToFormValues({ script: "ls", returns: "true" });
    expect(form.timeout).toBe(DEFAULT_END_CONDITION_VALUES.END_TIMEOUT_STRING);
    expect(form.maxRetries).toBe(DEFAULT_END_CONDITION_VALUES.END_RETRIES_STRING);
    expect(form.retryPrompt).toBe(DEFAULT_END_CONDITION_VALUES.END_RETRY_PROMPT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildEndConditionFromValues
// ─────────────────────────────────────────────────────────────────────────────

describe("buildEndConditionFromValues", () => {
  const base = {
    script: "npm test",
    returns: "true",
    timeout: DEFAULT_END_CONDITION_VALUES.END_TIMEOUT_STRING,
    maxRetries: DEFAULT_END_CONDITION_VALUES.END_RETRIES_STRING,
    retryPrompt: "",
  };

  it("returns undefined when enabled is false (inherit from workflow)", () => {
    expect(buildEndConditionFromValues({ ...base, enabled: false })).toBeUndefined();
  });

  it("returns null when enabled but script is empty (explicitly disabled)", () => {
    expect(buildEndConditionFromValues({ ...base, enabled: true, script: "" })).toBeNull();
  });

  it("returns null when enabled but returns is empty", () => {
    expect(buildEndConditionFromValues({ ...base, enabled: true, returns: "" })).toBeNull();
  });

  it("returns an end condition object when enabled with script+returns", () => {
    const result = buildEndConditionFromValues({ ...base, enabled: true });
    expect(result).toMatchObject({ script: "npm test", returns: "true" });
  });

  it("omits timeout when equal to default", () => {
    const result = buildEndConditionFromValues({ ...base, enabled: true }) as unknown as Record<string, unknown>;
    expect(result?.timeout).toBeUndefined();
  });

  it("includes timeout when different from default", () => {
    const result = buildEndConditionFromValues({
      ...base,
      enabled: true,
      timeout: "5000",
    }) as unknown as Record<string, unknown>;
    expect(result?.timeout).toBe(5000);
  });

  it("includes maxRetries when different from default", () => {
    const result = buildEndConditionFromValues({
      ...base,
      enabled: true,
      maxRetries: "3",
    }) as unknown as Record<string, unknown>;
    expect(result?.maxRetries).toBe(3);
  });

  it("includes retryPrompt when non-empty", () => {
    const result = buildEndConditionFromValues({
      ...base,
      enabled: true,
      retryPrompt: "Please fix the test failures.",
    }) as unknown as Record<string, unknown>;
    expect(result?.retryPrompt).toBe("Please fix the test failures.");
  });

  it("round-trips: toFormValues → buildFromValues returns equivalent object", () => {
    const original = { script: "pytest", returns: "0", maxRetries: 2, retryPrompt: "Retry" };
    const form = endConditionToFormValues(original);
    const rebuilt = buildEndConditionFromValues(form);
    expect(rebuilt).toMatchObject({ script: "pytest", returns: "0", maxRetries: 2 });
  });
});
