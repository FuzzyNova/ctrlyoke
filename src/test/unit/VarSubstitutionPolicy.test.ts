import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { VAR_SUBSTITUTION_POLICY } from "../../utils/VarSubstitutionPolicy";
import {
  VAR_SUBSTITUTION_PHASES,
  VAR_SUBSTITUTION_KINDS,
  VAR_SUBSTITUTION_UNRESOLVED,
} from "../../utils/VarSubstitutionPolicy";

suite("VarSubstitutionPolicy documentation", () => {
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
