import * as assert from "assert";
import { suite, test } from "mocha";
import {
  buildHostedErrorPage,
  renderHostedErrorPage,
} from "../../server/HostedErrorPageTemplate";

suite("renderHostedErrorPage", () => {
  test("substitutes every placeholder into the given template", () => {
    const template = [
      "<title>__CTRLYOKE_TITLE__</title>",
      "__CTRLYOKE_THEME_STYLE_BLOCK__",
      '<body class="__CTRLYOKE_BODY_CLASS__">',
      "Error __CTRLYOKE_STATUS_CODE__",
      "__CTRLYOKE_MESSAGE__",
      "__CTRLYOKE_HINTS_BLOCK__",
    ].join("\n");

    const html = renderHostedErrorPage(template, {
      statusCode: 401,
      message: "hello",
      hints: ["a hint"],
      themeBodyClass: "vscode-dark",
      themeStyleBlock: "<style>:root{}</style>",
    });

    assert.ok(html.includes("<title>Unauthorized</title>"));
    assert.ok(html.includes("<style>:root{}</style>"));
    assert.ok(html.includes('<body class="vscode-dark">'));
    assert.ok(html.includes("Error 401"));
    assert.ok(html.includes("hello"));
    assert.ok(html.includes("<li>a hint</li>"));
    assert.ok(!html.includes("__CTRLYOKE_"));
  });

  test("throws when the template is missing a required placeholder", () => {
    assert.throws(
      () =>
        renderHostedErrorPage("<title>__CTRLYOKE_TITLE__</title>", {
          statusCode: 404,
          message: "gone",
          themeBodyClass: "vscode-dark",
          themeStyleBlock: "",
        }),
      /Missing hosted error page placeholder/
    );
  });
});

suite("HostedErrorPageTemplate", () => {
  test("renders the message, theme vars, and body class for a 401 page", () => {
    const html = buildHostedErrorPage({
      statusCode: 401,
      message: "You need a valid token.",
      hints: ["Check your token.", "Reconnect via the ctrlyoke panel."],
      themeBodyClass: "vscode-dark",
      themeStyleBlock: "<style>:root {\n  --vscode-foreground: #fff;\n}</style>\n",
    });

    assert.ok(html.includes("Error 401"));
    assert.ok(html.includes("You need a valid token."));
    assert.ok(html.includes("Check your token."));
    assert.ok(html.includes("Reconnect via the ctrlyoke panel."));
    assert.ok(html.includes('<body class="vscode-dark">'));
    assert.ok(html.includes("--vscode-foreground: #fff;"));
    assert.ok(html.includes('src="/app-icon.svg"'));
  });

  test("omits the hints list when no hints are provided", () => {
    const html = buildHostedErrorPage({
      statusCode: 404,
      message: "That page doesn't exist.",
      themeBodyClass: "vscode-light",
      themeStyleBlock: "",
    });

    assert.ok(html.includes("Error 404"));
    assert.ok(!html.includes('<ul class="ctrlyoke-error-hints">'));
  });

  test("escapes HTML special characters in the message and hints", () => {
    const html = buildHostedErrorPage({
      statusCode: 401,
      message: '<script>alert("xss")</script>',
      hints: ["<img src=x onerror=alert(1)>"],
      themeBodyClass: "vscode-dark",
      themeStyleBlock: "",
    });

    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img src=x"));
  });
});
