import * as assert from "assert";
import { suite, test } from "mocha";
import { getErrorMessage } from "../../utils/ErrorUtils";

suite("ErrorUtils", () => {
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
      assert.strictEqual(getErrorMessage("raw string error"), "raw string error");
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
});
