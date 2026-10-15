import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowsCommandLine } from "./spawn-windows-shim.mjs";

test("quotes paths and escapes cmd metacharacters and embedded quotes", () => {
  assert.equal(
    buildWindowsCommandLine("C:\\Program Files\\Code&Tools\\code.cmd", [
      "--extensionDevelopmentPath=C:\\Users\\Jane Doe\\ctrlyoke",
      'C:\\repo\\a&b^c\\a"b',
    ]),
    'C:\\Program^ Files\\Code^&Tools\\code.cmd ^"--extensionDevelopmentPath=C:\\Users\\Jane^ Doe\\ctrlyoke^" ^"C:\\repo\\a^&b^^c\\a\\^"b^"'
  );
});
