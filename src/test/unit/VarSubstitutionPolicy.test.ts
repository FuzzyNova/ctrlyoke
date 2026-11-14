import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { VAR_SUBSTITUTION_POLICY } from "../../utils/VarSubstitutionPolicy";

suite("VarSubstitutionPolicy documentation", () => {
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
