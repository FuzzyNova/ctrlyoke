import * as assert from "node:assert";
import { suite, test } from "mocha";
import { colorizeSvg } from "../../server/IconColorizer";
import {
  ICON_BG_COLOR_DEFAULT,
  ICON_FG_COLOR_DEFAULT,
} from "../../types/IconColorDefaults";

suite("colorizeSvg", () => {
  test("keeps swapped custom colors distinct in one replacement pass", () => {
    const svg = `<svg><rect fill="${ICON_BG_COLOR_DEFAULT}"/><path stroke="${ICON_FG_COLOR_DEFAULT}"/><circle fill="${ICON_BG_COLOR_DEFAULT}"/></svg>`;

    const colorized = colorizeSvg(
      svg,
      ICON_FG_COLOR_DEFAULT,
      ICON_BG_COLOR_DEFAULT
    );

    assert.strictEqual(
      colorized,
      `<svg><rect fill="${ICON_FG_COLOR_DEFAULT}"/><path stroke="${ICON_BG_COLOR_DEFAULT}"/><circle fill="${ICON_FG_COLOR_DEFAULT}"/></svg>`
    );
  });
});
