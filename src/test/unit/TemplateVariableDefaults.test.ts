import * as assert from "assert";
import { suite, test } from "mocha";
import {
  TEMPLATE_VARIABLE_DEFAULT_SOURCES as SOURCE,
  TEMPLATE_VARIABLE_TYPES as TYPE,
  SETTING_SCOPES,
} from "../../types/DashboardConstants";
import {
  classifyTemplateVariableDefaults,
  resolveTemplateVariableDefaults,
  shouldClearTemplateVariableDefaults,
  type TemplateVariableDefaultDefinition,
} from "../../utils/TemplateVariableDefaults";

suite("TemplateVariableDefaults", () => {
  const definitions: TemplateVariableDefaultDefinition[] = [
    { name: "folder", type: TYPE.TEXT, default: "authored" },
    { name: "harness", type: TYPE.HARNESS, default: "claude-cli" },
    { name: "model", type: TYPE.MODEL, harness: "harness", default: "opus" },
    { name: "format", type: TYPE.SELECT, options: ["json", "yaml"], default: "yaml" },
  ];

  test("merges workspace and user defaults per variable and exposes provenance", () => {
    const resolved = resolveTemplateVariableDefaults(
      definitions,
      { folder: "user-folder", format: "json" },
      { folder: "workspace-folder" }
    );
    assert.deepStrictEqual(
      resolved.map(({ variable }) => [variable.name, variable.default, variable.authoredDefault, variable.defaultSource]),
      [
        ["folder", "workspace-folder", "authored", SOURCE.WORKSPACE],
        ["harness", "claude-cli", "claude-cli", SOURCE.TEMPLATE],
        ["model", "opus", "opus", SOURCE.TEMPLATE],
        ["format", "json", "yaml", SOURCE.USER],
      ]
    );
  });

  test("resolves linked models from the harness scope without falling through", () => {
    const userPair = resolveTemplateVariableDefaults(
      definitions,
      { harness: "codex-cli", model: "gpt-6-luna" },
      { harness: "claude-cli" }
    );
    assert.deepStrictEqual(
      userPair.slice(1, 3).map(({ variable }) => [variable.default, variable.defaultSource]),
      [["claude-cli", SOURCE.WORKSPACE], ["opus", SOURCE.TEMPLATE]]
    );

    const workspacePair = resolveTemplateVariableDefaults(
      definitions,
      { harness: "codex-cli", model: "gpt-6-luna" },
      { harness: "codex-cli", model: "gpt-6-codex" }
    );
    assert.deepStrictEqual(
      workspacePair.slice(1, 3).map(({ variable }) => [variable.default, variable.defaultSource]),
      [["codex-cli", SOURCE.WORKSPACE], ["gpt-6-codex", SOURCE.WORKSPACE]]
    );
  });

  test("classifies unknown variables, invalid harnesses and invalid select options", () => {
    const { validValues, issues } = classifyTemplateVariableDefaults(
      definitions,
      { gone: "old", harness: "removed-cli", model: "old-model", format: "toml" },
      undefined
    );
    assert.deepStrictEqual(validValues.user, {});
    assert.deepStrictEqual(
      issues.map(({ variableName, reason }) => [variableName, reason]),
      [
        ["gone", "unknown-variable"],
        ["harness", "invalid-harness"],
        ["format", "invalid-select"],
        ["model", "linked-model-dropped"],
      ]
    );
  });

  test("compares against the inherited value at the target scope", () => {
    assert.strictEqual(
      shouldClearTemplateVariableDefaults(definitions, SETTING_SCOPES.USER, undefined, undefined, { folder: "authored" }),
      true
    );
    assert.strictEqual(
      shouldClearTemplateVariableDefaults(definitions, SETTING_SCOPES.WORKSPACE, { folder: "user" }, { folder: "x" }, { folder: "user" }),
      true
    );
    // Authored value at Workspace must be stored when it differs from the User value.
    assert.strictEqual(
      shouldClearTemplateVariableDefaults(definitions, SETTING_SCOPES.WORKSPACE, { folder: "different-user" }, undefined, { folder: "authored" }),
      false
    );
    assert.strictEqual(
      shouldClearTemplateVariableDefaults(definitions, SETTING_SCOPES.WORKSPACE, undefined, undefined, { harness: "claude-cli" }),
      false,
      "a harness pin must include its linked model as one unit"
    );
  });
});
