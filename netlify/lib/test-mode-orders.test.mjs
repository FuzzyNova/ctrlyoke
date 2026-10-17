import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldIssueTestModeLicense } from "./test-mode-orders.ts";

describe("shouldIssueTestModeLicense", () => {
  it("skips test-mode orders when the override is unset", () => {
    assert.equal(shouldIssueTestModeLicense(true, undefined), false);
  });

  it("allows test-mode orders when the override is truthy", () => {
    assert.equal(shouldIssueTestModeLicense(true, "true"), true);
    assert.equal(shouldIssueTestModeLicense(true, "1"), true);
  });

  it("allows live orders and events with no test_mode value", () => {
    assert.equal(shouldIssueTestModeLicense(false, undefined), true);
    assert.equal(shouldIssueTestModeLicense(undefined, undefined), true);
  });
});
