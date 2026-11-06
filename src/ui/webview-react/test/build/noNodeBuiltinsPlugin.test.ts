import { describe, expect, it } from "vitest";
import { findForbiddenNodeBuiltin } from "../../build/noNodeBuiltinsPlugin";

const SOURCE_FILE = "C:/dev/ctrlyoke/src/utils/Example.ts";

describe("findForbiddenNodeBuiltin", () => {
  it("flags bare, node:-prefixed and subpath built-ins imported by ctrlyoke code", () => {
    expect(findForbiddenNodeBuiltin("crypto", SOURCE_FILE)).toBe("crypto");
    expect(findForbiddenNodeBuiltin("node:path", SOURCE_FILE)).toBe(
      "node:path"
    );
    expect(findForbiddenNodeBuiltin("fs/promises", SOURCE_FILE)).toBe(
      "fs/promises"
    );
  });

  it("allows packages and relative imports", () => {
    expect(findForbiddenNodeBuiltin("react", SOURCE_FILE)).toBeUndefined();
    expect(
      findForbiddenNodeBuiltin("./SecretName", SOURCE_FILE)
    ).toBeUndefined();
    expect(
      findForbiddenNodeBuiltin("@root/utils/SecretName", SOURCE_FILE)
    ).toBeUndefined();
  });

  it("leaves node_modules, virtual modules and entry points to Vite", () => {
    expect(
      findForbiddenNodeBuiltin(
        "crypto",
        "C:\\dev\\ctrlyoke\\node_modules\\pkg\\index.js"
      )
    ).toBeUndefined();
    expect(findForbiddenNodeBuiltin("crypto", "\0virtual:x")).toBeUndefined();
    expect(findForbiddenNodeBuiltin("crypto", undefined)).toBeUndefined();
  });
});
