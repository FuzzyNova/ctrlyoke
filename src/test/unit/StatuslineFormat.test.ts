import * as assert from "assert";
import { suite, test } from "mocha";
import {
  DEFAULT_STATUS_LINE_FORMAT,
  isDefaultStatusLineFormat,
  type StatusLineSegment,
} from "../../utils/StatuslineFormat";

suite("Statusline format helpers", () => {
  test("recognizes an exact copy of the default format", () => {
    const format = DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment }));

    assert.strictEqual(isDefaultStatusLineFormat(format), true);
  });

  test("treats an explicitly undefined optional color as absent", () => {
    const format = DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({
      ...segment,
      color: undefined,
    })) as StatusLineSegment[];

    assert.strictEqual(isDefaultStatusLineFormat(format), true);
  });

  test("rejects the same segments in a different order", () => {
    const format = DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment }));
    [format[0], format[1]] = [format[1], format[0]];

    assert.strictEqual(isDefaultStatusLineFormat(format), false);
  });

  test("rejects a customized format", () => {
    const format = DEFAULT_STATUS_LINE_FORMAT.map((segment) => ({ ...segment }));
    format[0] = { type: "literal", text: "custom" };

    assert.strictEqual(isDefaultStatusLineFormat(format), false);
  });
});
