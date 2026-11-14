import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { VAR_SUBSTITUTION_POLICY } from "../../utils/VarSubstitutionPolicy";
import { VarSubstitutor } from "../../utils/VarSubstitutor";
import {
  VAR_SUBSTITUTION_PHASES,
  VAR_SUBSTITUTION_KINDS,
  VAR_SUBSTITUTION_UNRESOLVED,
} from "../../utils/VarSubstitutionPolicy";

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
    const resolved = VarSubstitutor.substituteWorkflowView(
      authored,
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
    );
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

  test("keeps numeric expected and session references numeric", () => {
    const resolved = VarSubstitutor.substituteWorkflowView(
      { type: "script", script: "echo hi", expected: 3, sessionId: 1 },
      { expected: "4", session: "abc" },
      "dispatch"
    );
    assert.strictEqual(resolved.expected, 3);
    assert.strictEqual(resolved.sessionId, 1);
  });

  test("reports unresolved strict fields with their indexed schema path", () => {
    assert.throws(
      () =>
        VarSubstitutor.substituteWorkflowView(
          { type: "script", script: "echo hi", skills: ["{{missing}}"] },
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
      assert.deepStrictEqual(VAR_SUBSTITUTION_POLICY[field], {
        phase: VAR_SUBSTITUTION_PHASES.RUN_START,
        kind: VAR_SUBSTITUTION_KINDS.TEXT,
        fencedCodeProtected: false,
        unresolved: VAR_SUBSTITUTION_UNRESOLVED.ERROR,
      });
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
