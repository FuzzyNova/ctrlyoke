import assert from "node:assert/strict";
import test from "node:test";
import { findHardcodedStringGroups } from "./find-hardcoded-strings.mjs";

test("no repeated flow-control string literal touches production code without a shared constant", () => {
  const { actionable } = findHardcodedStringGroups();
  if (actionable.length === 0) return;

  const detail = actionable
    .map(
      (group) =>
        `  "${group.value}" (${group.count}x): ` +
        group.locations.map((loc) => loc.location).join(", ")
    )
    .join("\n");
  assert.fail(
    `${actionable.length} flow-control string literal(s) repeat across production code ` +
      `without a shared constant:\n${detail}\n` +
      "Run `npm run find-hardcoded-strings` for details. Single-source each in " +
      "DashboardConstants.ts/CtrlYokeTypes.ts (or a closer-scoped local constant) — or, if the " +
      "repeats are genuinely unrelated concepts that happen to share spelling, add the literal " +
      "to KNOWN_UNRELATED_LITERALS in scripts/find-hardcoded-strings.mjs with a comment " +
      "explaining why."
  );
});
