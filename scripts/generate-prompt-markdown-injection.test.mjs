import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import markdownLanguage from "@shikijs/langs/markdown";
import yamlLanguage from "@shikijs/langs/yaml";
import { INITIAL, Registry } from "@shikijs/vscode-textmate";

/**
 * VS Code's own YAML grammar is covered by
 * `src/test/integration/promptMarkdownGrammar.integration.test.ts`. This test
 * runs the injection under the older TextMate YAML grammar, which Red Hat's
 * YAML extension registers as `source.yaml` in place of VS Code's. Shiki
 * bundles that same grammar.
 */

const INJECTION_SCOPE = "ctrlyoke.prompt-markdown.injection";
const injection = JSON.parse(
  readFileSync(
    new URL(
      "../syntaxes/ctrlyoke-prompt-markdown.injection.json",
      import.meta.url
    ),
    "utf8"
  )
);

const grammars = new Map(
  [...yamlLanguage, ...markdownLanguage, injection].map((grammar) => [
    grammar.scopeName,
    grammar,
  ])
);

async function tokenize(lines) {
  const engine = await createOnigurumaEngine(
    import("@shikijs/engine-oniguruma/wasm-inlined")
  );
  const registry = new Registry({
    onigLib: {
      createOnigScanner: (sources) => engine.createScanner(sources),
      createOnigString: (text) => engine.createString(text),
    },
    loadGrammar: (scopeName) => grammars.get(scopeName) ?? null,
    getInjections: (scopeName) =>
      scopeName === "source.yaml" ? [INJECTION_SCOPE] : [],
  });
  const grammar = await registry.loadGrammar("source.yaml");
  assert.ok(grammar);
  let state = INITIAL;
  return lines.map((line) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      scopes: token.scopes.join(" "),
    }));
  });
}

const FIXTURE = [
  "steps:",
  "  - name: remember-info",
  "    prompt: |",
  "      # Heading",
  "      text with a colon: example text",
  "      *italic* and `code`",
  "",
  "      [link](https://example.com)",
  "    resumeSession: false",
  "  - prompt: >-",
  "",
  "      Folded **bold**",
  "    model: m",
  "tail: after",
];

/** Scopes of the first token on line `index` whose text includes `text`. */
function scopesOf(lines, index, text) {
  return lines[index].find((token) => token.text.includes(text))?.scopes ?? "";
}

test("colours markdown inside a block scalar under the classic YAML grammar", async () => {
  const lines = await tokenize(FIXTURE);
  assert.match(scopesOf(lines, 3, "Heading"), /markup\.heading\.markdown/);
  assert.match(scopesOf(lines, 5, "italic"), /markup\.italic\.markdown/);
  assert.match(scopesOf(lines, 5, "code"), /markup\.inline\.raw/);
  assert.match(scopesOf(lines, 7, "example.com"), /markup\.underline\.link/);
  // A blank first line keeps the scalar open.
  assert.match(scopesOf(lines, 11, "bold"), /markup\.bold\.markdown/);
});

test("keeps the prompt text out of YAML mapping scopes", async () => {
  const lines = await tokenize(FIXTURE);
  const scopes = scopesOf(lines, 4, "colon");
  assert.match(scopes, /meta\.embedded\.block\.markdown/);
  assert.doesNotMatch(scopes, /entity\.name\.tag/);
});

test("returns to YAML after each block scalar", async () => {
  const lines = await tokenize(FIXTURE);
  // The classic grammar tokenizes a key's first character on its own.
  for (const [index, key] of [
    [8, "esumeSession"],
    [12, "odel"],
    [13, "ail"],
  ]) {
    const scopes = scopesOf(lines, index, key);
    assert.match(scopes, /entity\.name\.tag\.yaml/, key);
    assert.doesNotMatch(scopes, /markdown/, key);
  }
});
