import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HTTP_BYTE_RANGE_RESULT_KINDS,
  parseHttpByteRange,
} from "../../server/HttpByteRange";

suite("parseHttpByteRange", () => {
  test("parses bounded and open-ended ranges", () => {
    assert.deepStrictEqual(parseHttpByteRange("bytes=2-5", 10), {
      kind: HTTP_BYTE_RANGE_RESULT_KINDS.RANGE,
      start: 2,
      end: 5,
    });
    assert.deepStrictEqual(parseHttpByteRange("bytes=7-", 10), {
      kind: HTTP_BYTE_RANGE_RESULT_KINDS.RANGE,
      start: 7,
      end: 9,
    });
  });

  test("parses suffix ranges", () => {
    assert.deepStrictEqual(parseHttpByteRange("bytes=-3", 10), {
      kind: HTTP_BYTE_RANGE_RESULT_KINDS.RANGE,
      start: 7,
      end: 9,
    });
  });

  test("marks out-of-bounds ranges unsatisfiable", () => {
    assert.deepStrictEqual(parseHttpByteRange("bytes=10-", 10), {
      kind: HTTP_BYTE_RANGE_RESULT_KINDS.UNSATISFIABLE,
    });
  });

  test("ignores multi-range requests", () => {
    assert.deepStrictEqual(parseHttpByteRange("bytes=0-1,4-5", 10), {
      kind: HTTP_BYTE_RANGE_RESULT_KINDS.NONE,
    });
  });
});
