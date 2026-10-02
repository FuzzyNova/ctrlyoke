import * as assert from "assert";
import { suite, test } from "mocha";
import {
  classifyCtrlYokeSlashToken,
  extractCtrlYokeSlashToken,
  rewriteCtrlYokeSlashTokens,
  scanCtrlYokeSlashTokens,
} from "../../utils/CtrlYokeSlashTokens";

suite("CtrlYokeSlashTokens", () => {
  test("recognizes only explicit skill and MCP references", () => {
    assert.strictEqual(classifyCtrlYokeSlashToken("/skill:commit"), "skill");
    assert.strictEqual(classifyCtrlYokeSlashToken("/mcp:playwright"), "mcp");
    assert.strictEqual(classifyCtrlYokeSlashToken("/commit"), undefined);
    assert.strictEqual(classifyCtrlYokeSlashToken("/mcp"), undefined);
    assert.strictEqual(classifyCtrlYokeSlashToken("/skill:"), undefined);
  });

  test("extracts names with supported punctuation", () => {
    assert.deepStrictEqual(extractCtrlYokeSlashToken("/skill:code-review"), {
      kind: "skill",
      name: "code-review",
    });
    assert.deepStrictEqual(extractCtrlYokeSlashToken("/mcp:browser_test.v2"), {
      kind: "mcp",
      name: "browser_test.v2",
    });
  });

  test("does not swallow sentence punctuation into the name", () => {
    // A trailing "." or "-" is ordinary prose, not part of the reference. If it
    // were captured, the name would never resolve and the literal token would
    // reach the harness — the exact collision this syntax exists to avoid.
    assert.deepStrictEqual(
      scanCtrlYokeSlashTokens("commit the changes using /skill:commit.").map(
        (token) => token.raw
      ),
      ["/skill:commit"]
    );
    assert.deepStrictEqual(
      scanCtrlYokeSlashTokens("check the UI with /mcp:playwright!").map(
        (token) => token.name
      ),
      ["playwright"]
    );
    assert.strictEqual(
      rewriteCtrlYokeSlashTokens("commit using /skill:commit."),
      "commit using skill: commit."
    );
  });

  test("leaves the three-segment tool form untouched", () => {
    // `/mcp:<server>:<tool>` is a follow-on phase; until it ships it must not be
    // mistaken for a server reference with trailing text.
    assert.deepStrictEqual(
      scanCtrlYokeSlashTokens("/mcp:playwright:browser_hover"),
      []
    );
  });

  test("scans every occurrence with source locations", () => {
    const text = "use /skill:commit and /mcp:playwright now";
    assert.deepStrictEqual(scanCtrlYokeSlashTokens(text), [
      {
        kind: "skill",
        name: "commit",
        index: 4,
        length: 13,
        raw: "/skill:commit",
      },
      {
        kind: "mcp",
        name: "playwright",
        index: 22,
        length: 15,
        raw: "/mcp:playwright",
      },
    ]);
  });

  test("only scans slash tokens at a word start", () => {
    const text =
      'https://example.com/skill:commit x/skill:commit xskill: commit docs/mcp:github a//skill:no ./skill:dot :/mcp:colon /skill:space (/mcp:paren "/skill:quote';
    assert.deepStrictEqual(
      scanCtrlYokeSlashTokens(text).map((token) => token.raw),
      ["/skill:space", "/mcp:paren", "/skill:quote"]
    );
  });

  test("rewrites every supported token in place", () => {
    assert.strictEqual(
      rewriteCtrlYokeSlashTokens("/skill:commit"),
      "skill: commit"
    );
    assert.strictEqual(
      rewriteCtrlYokeSlashTokens(
        "using /skill:commit, commit just the changes to file.txt"
      ),
      "using skill: commit, commit just the changes to file.txt"
    );
    assert.strictEqual(
      rewriteCtrlYokeSlashTokens(
        "perform a code review using /skill:code-review, then run tests with /skill:test"
      ),
      "perform a code review using skill: code-review, then run tests with skill: test"
    );
    assert.strictEqual(
      rewriteCtrlYokeSlashTokens(
        "using /mcp:ctrlyoke, append steps to the queue"
      ),
      "using mcp: ctrlyoke, append steps to the queue"
    );
    assert.strictEqual(
      rewriteCtrlYokeSlashTokens(
        "only use /mcp:ctrlyoke if you need to add more steps, and only use /mcp:playwright if you need to test a UI"
      ),
      "only use mcp: ctrlyoke if you need to add more steps, and only use mcp: playwright if you need to test a UI"
    );
  });

  test("leaves native and malformed slash tokens unchanged", () => {
    const text = "/commit /mcp /skill: /skill:valid:extra";
    assert.deepStrictEqual(scanCtrlYokeSlashTokens(text), []);
    assert.strictEqual(rewriteCtrlYokeSlashTokens(text), text);
  });

  test("does not scan or rewrite /skill:/mcp: refs inside fenced blocks", () => {
    const text = "```\n/skill:fenced\n```\nUse /skill:real instead.";
    assert.deepStrictEqual(
      scanCtrlYokeSlashTokens(text).map((token) => token.name),
      ["real"]
    );
    assert.strictEqual(
      rewriteCtrlYokeSlashTokens(text),
      "```\n/skill:fenced\n```\nUse skill: real instead."
    );
  });
});
