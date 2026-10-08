import * as assert from "assert";
import { suite, test } from "mocha";
import {
  WORKFLOW_KIND_PROPERTY_SNIPPETS,
  WORKFLOW_PROPERTY_SNIPPETS,
} from "../../completions/WorkflowPropertySnippets";
import { WORKFLOW_OBJECT_KINDS } from "../../types/DashboardConstants";
import { WORKFLOW_SCHEMA_OUTLINE } from "../../types/generated/WorkflowSchemaOutline";

suite("WorkflowPropertySnippets", () => {
  test("every snippet key is a key some outline object offers", () => {
    const outlineKeys = new Set(
      Object.values(WORKFLOW_SCHEMA_OUTLINE).flatMap((object) =>
        Object.keys(object.properties)
      )
    );
    const stale = Object.keys(WORKFLOW_PROPERTY_SNIPPETS).filter(
      (key) => !outlineKeys.has(key)
    );
    assert.deepStrictEqual(stale, [], "snippets for keys the schema dropped");
  });

  test("snippets insert their own key", () => {
    for (const [key, snippet] of Object.entries(WORKFLOW_PROPERTY_SNIPPETS)) {
      if (snippet.insertSnippet !== undefined) {
        assert.ok(
          snippet.insertSnippet.startsWith(`${key}:`),
          `${key} snippet: ${snippet.insertSnippet}`
        );
      }
    }
  });

  test("every per-object snippet key exists in that object's outline", () => {
    for (const [kind, snippets] of Object.entries(
      WORKFLOW_KIND_PROPERTY_SNIPPETS
    )) {
      const outline =
        WORKFLOW_SCHEMA_OUTLINE[kind as keyof typeof WORKFLOW_SCHEMA_OUTLINE];
      for (const key of Object.keys(snippets)) {
        assert.ok(outline?.properties[key], `${kind}.${key} left the schema`);
      }
    }
  });
});

suite("WorkflowSchemaOutline", () => {
  test("covers each schema-backed object kind with at least one key", () => {
    for (const kind of [
      WORKFLOW_OBJECT_KINDS.WORKFLOW_ROOT,
      WORKFLOW_OBJECT_KINDS.PROMPT_STEP,
      WORKFLOW_OBJECT_KINDS.SCRIPT_STEP,
      WORKFLOW_OBJECT_KINDS.PARALLEL_GROUP,
      WORKFLOW_OBJECT_KINDS.END_CONDITION,
      WORKFLOW_OBJECT_KINDS.PRE_CONDITION,
      WORKFLOW_OBJECT_KINDS.TOOL_PERMISSIONS,
      WORKFLOW_OBJECT_KINDS.ERROR_BEHAVIOR,
      WORKFLOW_OBJECT_KINDS.HOOK,
      WORKFLOW_OBJECT_KINDS.WORKTREE,
      WORKFLOW_OBJECT_KINDS.TEMPLATE_META,
      WORKFLOW_OBJECT_KINDS.PROMPT_FILE_FRONTMATTER,
    ]) {
      const outline = WORKFLOW_SCHEMA_OUTLINE[kind];
      assert.ok(
        outline && Object.keys(outline.properties).length > 0,
        `${kind} outline`
      );
    }
  });
});
