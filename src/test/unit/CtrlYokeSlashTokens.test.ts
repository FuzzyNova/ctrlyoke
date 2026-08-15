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
    assert.strictEqual(
      classifyCtrlYokeSlashToken("/mcp:playwright"),
      "mcp"
    );
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
      rewriteCtrlYokeSlashTokens("using /mcp:ctrlyoke, append steps to the queue"),
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
});
