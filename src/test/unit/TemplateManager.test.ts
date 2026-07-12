import * as assert from "assert";
import { suite, test } from "mocha";
import { TemplateManager } from "../../core/TemplateManager";

// parseTemplateMeta and mergeVariablesWithMeta are private but pure — they operate
// only on strings/objects and never touch the ExtensionContext — so we construct a
// manager with a stub context and reach the methods via `as any` to unit-test the
// variable metadata model without needing a workspace or file system.
function makeManager(): any {
  return new TemplateManager({} as never);
}

suite("TemplateManager variable metadata", () => {
  suite("parseTemplateMeta", () => {
    test("parses type, fileFilter, autoFillFilename, description, default, multiline", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  name: Demo",
        "  description: A demo",
        "  variables:",
        "    specFile:",
        "      type: file",
        "      fileFilter:",
        '        - "**/*.md"',
        "      autoFillFilename: true",
        "    testCommand:",
        "      type: text",
        "      default: npm test",
        "      description: The test command.",
        "      multiline: true",
        "steps:",
        "  - prompt: hi",
        "",
      ].join("\n");

      const meta = tm.parseTemplateMeta(content);
      assert.strictEqual(meta.name, "Demo");
      assert.strictEqual(meta.description, "A demo");
      assert.deepStrictEqual(meta.variables.specFile, {
        type: "file",
        fileFilter: ["**/*.md"],
        autoFillFilename: true,
      });
      assert.deepStrictEqual(meta.variables.testCommand, {
        type: "text",
        default: "npm test",
        description: "The test command.",
        multiline: true,
      });
    });

    test("returns empty variables when _templateMeta is absent or malformed", () => {
      const tm = makeManager();
      assert.deepStrictEqual(tm.parseTemplateMeta("steps: []").variables, {});
      assert.deepStrictEqual(
        tm.parseTemplateMeta("::: not : yaml :").variables,
        {}
      );
    });

    test("parses select (with options) and directory types", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  variables:",
        "    logLevel:",
        "      type: select",
        "      options:",
        "        - debug",
        "        - info",
        "      default: info",
        "    outputDir:",
        "      type: directory",
        "steps: []",
      ].join("\n");
      const meta = tm.parseTemplateMeta(content);
      assert.deepStrictEqual(meta.variables.logLevel, {
        type: "select",
        options: ["debug", "info"],
        default: "info",
      });
      assert.deepStrictEqual(meta.variables.outputDir, { type: "directory" });
    });

    test("rejects an options array containing non-strings", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  variables:",
        "    x:",
        "      type: select",
        "      options:",
        "        - ok",
        "        - 5",
        "steps: []",
      ].join("\n");
      const entry = tm.parseTemplateMeta(content).variables.x;
      assert.strictEqual(entry.type, "select");
      assert.strictEqual(entry.options, undefined);
    });

    test("ignores non-string default and non-true multiline", () => {
      const tm = makeManager();
      const content = [
        "_templateMeta:",
        "  variables:",
        "    x:",
        "      default: 123",
        "      multiline: false",
        "steps: []",
      ].join("\n");
      const entry = tm.parseTemplateMeta(content).variables.x;
      assert.strictEqual(entry.default, undefined);
      assert.strictEqual(entry.multiline, undefined);
    });
  });

  suite("mergeVariablesWithMeta", () => {
    test("enriches extracted variables by name (type, default, description, multiline)", () => {
      const tm = makeManager();
      const extracted = [
        { name: "featureDescription" },
        { name: "planDocument" },
      ];
      const meta = {
        featureDescription: {
          type: "text",
          multiline: true,
          description: "What to build",
        },
        planDocument: { type: "text", default: "docs/plan.md" },
      };
      const merged = tm.mergeVariablesWithMeta(extracted, meta, "demo");
      assert.deepStrictEqual(merged[0], {
        name: "featureDescription",
        type: "text",
        multiline: true,
        description: "What to build",
      });
      assert.deepStrictEqual(merged[1], {
        name: "planDocument",
        type: "text",
        default: "docs/plan.md",
      });
    });

    test("enriches with select options and directory type", () => {
      const tm = makeManager();
      const merged = tm.mergeVariablesWithMeta(
        [{ name: "logLevel" }, { name: "outDir" }],
        {
          logLevel: { type: "select", options: ["a", "b"], default: "a" },
          outDir: { type: "directory" },
        },
        "demo"
      );
      assert.deepStrictEqual(merged[0], {
        name: "logLevel",
        type: "select",
        options: ["a", "b"],
        default: "a",
      });
      assert.deepStrictEqual(merged[1], { name: "outDir", type: "directory" });
    });

    test("only the first autoFillFilename wins", () => {
      const tm = makeManager();
      const extracted = [{ name: "a" }, { name: "b" }];
      const meta = {
        a: { type: "file", autoFillFilename: true },
        b: { type: "file", autoFillFilename: true },
      };
      const merged = tm.mergeVariablesWithMeta(extracted, meta, "demo");
      assert.strictEqual(merged[0].autoFillFilename, true);
      assert.strictEqual(merged[1].autoFillFilename, undefined);
    });

    test("leaves variables without matching meta untouched", () => {
      const tm = makeManager();
      const extracted = [{ name: "loneVar" }];
      const merged = tm.mergeVariablesWithMeta(extracted, {}, "demo");
      assert.deepStrictEqual(merged, [{ name: "loneVar" }]);
    });
  });

  suite("extractVariables", () => {
    test("extracts typed and untyped tokens and filters retry placeholders", () => {
      const tm = makeManager();
      const vars = tm.extractVariables(
        "Run {testCommand}; see @{file:specFile}; note {stdout}"
      );
      const byName = Object.fromEntries(
        vars.map((v: { name: string }) => [v.name, v])
      );
      assert.ok(byName.testCommand, "plain token extracted");
      assert.strictEqual(byName.specFile.type, "file", "typed token → file");
      assert.strictEqual(
        byName.stdout,
        undefined,
        "reserved retry placeholder filtered out"
      );
    });
  });

  suite("custom template ID scope encoding", () => {
    test("buildCustomTemplateId round-trips through parseCustomTemplateId", () => {
      const tm = makeManager();
      const workspaceId = tm.buildCustomTemplateId("workspace", "my-template");
      assert.strictEqual(workspaceId, "custom:workspace:my-template");
      assert.deepStrictEqual(tm.parseCustomTemplateId(workspaceId), {
        scope: "workspace",
        name: "my-template",
      });

      const userId = tm.buildCustomTemplateId("user", "shared-template");
      assert.strictEqual(userId, "custom:user:shared-template");
      assert.deepStrictEqual(tm.parseCustomTemplateId(userId), {
        scope: "user",
        name: "shared-template",
      });
    });

    test("throws on malformed or unscoped custom template IDs", () => {
      const tm = makeManager();
      assert.throws(() => tm.parseCustomTemplateId("custom:no-scope-here"));
      assert.throws(() => tm.parseCustomTemplateId("custom:bogus-scope:name"));
    });
  });
});
