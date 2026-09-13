import * as assert from "assert";
import { suite, test } from "mocha";
import { sanitizeThemeVars } from "../../server/CtrlYokeHostedServer";

suite("sanitizeThemeVars", () => {
  test("keeps well-formed CSS custom-property vars", () => {
    const result = sanitizeThemeVars({
      "--cy-color-bg": "#1e1e1e",
      "--cy-color-accent": "rgba(0, 122, 204, 0.5)",
    });

    assert.deepStrictEqual(result, {
      "--cy-color-bg": "#1e1e1e",
      "--cy-color-accent": "rgba(0, 122, 204, 0.5)",
    });
  });

  test("drops values that could break out of a <style> block", () => {
    const result = sanitizeThemeVars({
      "--safe": "#fff",
      "--evil": "0}</style><script>alert(1)</script><style>{",
    });

    assert.deepStrictEqual(result, { "--safe": "#fff" });
  });

  test("drops keys that are not CSS custom properties", () => {
    const result = sanitizeThemeVars({
      "not-a-custom-prop": "red",
      "--also/bad": "red",
      "--ok": "red",
    });

    assert.deepStrictEqual(result, { "--ok": "red" });
  });

  test("drops non-string values", () => {
    const result = sanitizeThemeVars({
      "--ok": "red",
      "--bad": 123 as unknown as string,
    });

    assert.deepStrictEqual(result, { "--ok": "red" });
  });

  test("returns an empty object for an empty input", () => {
    assert.deepStrictEqual(sanitizeThemeVars({}), {});
  });
});
