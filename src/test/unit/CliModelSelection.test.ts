import * as assert from "assert";
import { suite, test } from "mocha";
import {
  resolveCliModelFlag,
  type CliModelRules,
} from "../../core/harness/shared/CliModelSelection";
import { MODEL_NONE } from "../../utils/ModelConstants";

suite("resolveCliModelFlag", () => {
  const known = new Map([
    ["alpha", "alpha"],
    ["Alpha-Long-Name", "alpha"],
    ["beta", "beta"],
  ]);
  const rules = (defaultModel: string, loaded = true): CliModelRules => ({
    logLabel: "TestProvider",
    defaultModel,
    recognize: (model) => known.get(model),
    isRegistryLoaded: () => loaded,
  });

  test("uses the default when the step names no model", () => {
    assert.strictEqual(resolveCliModelFlag(undefined, rules("beta")), "beta");
    assert.strictEqual(resolveCliModelFlag("", rules("beta")), "beta");
    assert.strictEqual(
      resolveCliModelFlag(undefined, rules("Alpha-Long-Name")),
      "alpha",
      "a recognised default is normalised like a requested model"
    );
    assert.strictEqual(
      resolveCliModelFlag(undefined, rules("custom-default")),
      "custom-default"
    );
  });

  test("passes no flag for an explicit none", () => {
    assert.strictEqual(
      resolveCliModelFlag(MODEL_NONE, rules("beta")),
      undefined
    );
  });

  test("passes a recognised model as recognise returns it", () => {
    assert.strictEqual(
      resolveCliModelFlag("Alpha-Long-Name", rules("beta")),
      "alpha"
    );
  });

  test("falls back to the default for an unrecognised model", () => {
    assert.strictEqual(resolveCliModelFlag("gamma", rules("beta")), "beta");
  });

  test("never passes a literal none when the default is none", () => {
    assert.strictEqual(
      resolveCliModelFlag("gamma", rules(MODEL_NONE)),
      undefined,
      "unrecognised model with a none default"
    );
    assert.strictEqual(
      resolveCliModelFlag(undefined, rules(MODEL_NONE)),
      undefined,
      "no model with a none default"
    );
    assert.strictEqual(resolveCliModelFlag("gamma", rules("")), undefined);
  });

  test("passes an unchecked model through while the registry is not loaded", () => {
    assert.strictEqual(
      resolveCliModelFlag("gamma", rules("beta", false)),
      "gamma"
    );
    assert.strictEqual(
      resolveCliModelFlag("Alpha-Long-Name", rules("beta", false)),
      "alpha",
      "recognition still applies before the registry loads"
    );
  });
});
