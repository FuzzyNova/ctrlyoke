import { suite, test, suiteSetup, suiteTeardown } from "mocha";
import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/**
 * The prompt markdown injection grammar (`syntaxes/`), read back through the
 * command VS Code's own colorization tests use. Each token's `t` is the space
 * separated scope list at that token.
 */
interface CapturedToken {
  readonly c: string;
  readonly t: string;
}

const CAPTURE_COMMAND = "_workbench.captureSyntaxTokens";
const FIXTURE = [
  "name: demo # plain yaml",
  "steps:",
  "  - prompt: |",
  "      # Heading",
  "      Some *emphasis* and `code`.",
  "      ```ts",
  "      const x = 1;",
  "      ```",
  "    type: prompt",
  "  - parallel:",
  "      - prompt: >-",
  "          Folded **bold** text",
  "        endCondition:",
  "          retryPrompt: |",
  "            ## Retry heading",
  "  - prompt: Review **inline** text",
  '  - prompt: "quoted **text**"',
  "tail: after",
].join("\n");

suite("Prompt markdown injection grammar", () => {
  let directory: string;
  let tokens: CapturedToken[];

  suiteSetup(async function () {
    this.timeout(60_000);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ctrlyoke-grammar-"));
    const file = path.join(directory, "demo.ctrlyoke.yaml");
    await fs.writeFile(file, FIXTURE, "utf8");
    const uri = vscode.Uri.file(file);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(uri)
    );
    // The grammar loads lazily; the first capture can race it.
    for (let attempt = 0; attempt < 20; attempt++) {
      tokens = (await vscode.commands.executeCommand(
        CAPTURE_COMMAND,
        uri
      )) as CapturedToken[];
      if (scopesOf("Heading").includes("markup.heading.markdown")) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await fs.rm(directory, { recursive: true, force: true });
  });

  /** Scopes of the first token whose text includes `text`. */
  function scopesOf(text: string, after = ""): string {
    const start = after
      ? tokens.findIndex((token) => token.c.includes(after))
      : 0;
    return (
      tokens.slice(Math.max(0, start)).find((token) => token.c.includes(text))
        ?.t ?? ""
    );
  }

  test("colours markdown inside a literal block scalar", () => {
    assert.ok(scopesOf("Heading").includes("markup.heading.markdown"));
    assert.ok(scopesOf("emphasis").includes("markup.italic.markdown"));
    assert.ok(scopesOf("code").includes("markup.inline.raw"));
    assert.ok(scopesOf("const", "```").includes("meta.embedded"));
  });

  test("colours markdown inside a folded block scalar nested under parallel", () => {
    assert.ok(scopesOf("bold").includes("markup.bold.markdown"));
  });

  test("colours markdown in retryPrompt", () => {
    assert.ok(scopesOf("Retry heading").includes("markup.heading.markdown"));
  });

  test("colours markdown in a single-line prompt", () => {
    assert.ok(scopesOf("inline").includes("markup.bold.markdown"));
  });

  test("leaves YAML scopes on keys, comments and the line after the block", () => {
    assert.ok(scopesOf("demo").includes("source.yaml"));
    assert.ok(!scopesOf("demo").includes("markdown"));
    assert.ok(scopesOf("plain yaml").includes("comment"));
    assert.ok(!scopesOf("after").includes("markdown"));
    assert.ok(!scopesOf("prompt", "type").includes("markdown"));
  });

  test("keeps a quoted prompt a YAML string", () => {
    const scopes = scopesOf("quoted", "Review");
    assert.ok(scopes.includes("string.quoted"));
    assert.ok(!scopes.includes("markup.bold"));
  });
});
