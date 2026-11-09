import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getErrorMessage,
  getErrnoCode,
  hasErrnoCode,
  toError,
} from "../../utils/ErrorUtils";
import { NODE_ERROR_CODES } from "../../types/DashboardConstants";

suite("ErrorUtils", () => {
  suite("errno helpers", () => {
    test("reads an errno code from an Error", () => {
      const error = Object.assign(new Error("missing"), {
        code: NODE_ERROR_CODES.ENOENT,
      });
      assert.strictEqual(getErrnoCode(error), NODE_ERROR_CODES.ENOENT);
      assert.strictEqual(hasErrnoCode(error, NODE_ERROR_CODES.ENOENT), true);
    });

    test("reads an errno code from a plain object", () => {
      assert.strictEqual(
        getErrnoCode({ code: NODE_ERROR_CODES.ENOENT }),
        NODE_ERROR_CODES.ENOENT
      );
    });

    test("checks multiple errno codes", () => {
      assert.strictEqual(
        hasErrnoCode(
          { code: NODE_ERROR_CODES.ENOTDIR },
          NODE_ERROR_CODES.ENOENT,
          NODE_ERROR_CODES.ENOTDIR
        ),
        true
      );
    });

    test("ignores non-string codes", () => {
      assert.strictEqual(getErrnoCode({ code: 2 }), undefined);
      assert.strictEqual(
        hasErrnoCode({ code: 2 }, NODE_ERROR_CODES.ENOENT),
        false
      );
    });

    for (const value of [null, undefined, "error", new Error("no code")]) {
      test(`returns no code for ${String(value)}`, () => {
        assert.strictEqual(getErrnoCode(value), undefined);
        assert.strictEqual(hasErrnoCode(value, NODE_ERROR_CODES.ENOENT), false);
      });
    }
  });

  suite("getErrorMessage", () => {
    test("extracts message from Error instance", () => {
      assert.strictEqual(getErrorMessage(new Error("boom")), "boom");
    });

    test("extracts message from TypeError", () => {
      assert.strictEqual(
        getErrorMessage(new TypeError("type issue")),
        "type issue"
      );
    });

    test("returns string directly when thrown as string", () => {
      assert.strictEqual(
        getErrorMessage("raw string error"),
        "raw string error"
      );
    });

    test("converts number to string", () => {
      assert.strictEqual(getErrorMessage(42), "42");
    });

    test("converts null to string 'null'", () => {
      assert.strictEqual(getErrorMessage(null), "null");
    });

    test("converts undefined to string 'undefined'", () => {
      assert.strictEqual(getErrorMessage(undefined), "undefined");
    });

    test("converts boolean to string", () => {
      assert.strictEqual(getErrorMessage(false), "false");
    });

    test("converts object to string representation", () => {
      assert.strictEqual(
        getErrorMessage({ message: "not an Error" }),
        "[object Object]"
      );
    });

    test("handles empty Error message", () => {
      assert.strictEqual(getErrorMessage(new Error("")), "");
    });

    test("handles Error with no argument", () => {
      assert.strictEqual(getErrorMessage(new Error()), "");
    });

    test("converts empty string", () => {
      assert.strictEqual(getErrorMessage(""), "");
    });

    test("converts zero", () => {
      assert.strictEqual(getErrorMessage(0), "0");
    });
  });

  suite("toError", () => {
    test("returns an Error instance unchanged", () => {
      const error = new Error("boom");
      assert.strictEqual(toError(error), error);
    });

    test("wraps a string", () => {
      assert.strictEqual(toError("boom").message, "boom");
    });

    test("wraps a non-Error object", () => {
      assert.strictEqual(
        toError({ message: "boom" }).message,
        "[object Object]"
      );
    });

    test("wraps null as the string null", () => {
      assert.strictEqual(toError(null).message, "null");
    });
  });
});
