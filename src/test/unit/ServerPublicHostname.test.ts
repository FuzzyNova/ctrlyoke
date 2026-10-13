import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import {
  isIpv4Literal,
  normalizePublicHostname,
  PUBLIC_HOSTNAME_MAX_LENGTH,
  PUBLIC_HOSTNAME_PATTERN_SOURCE,
  withUrlHostname,
} from "../../utils/ServerPublicHostname";

suite("ServerPublicHostname", () => {
  test("accepts DNS names and IPv4 addresses, trimmed and lower-cased", () => {
    assert.strictEqual(
      normalizePublicHostname(" My-PC.Example.ts.net "),
      "my-pc.example.ts.net"
    );
    assert.strictEqual(normalizePublicHostname("home"), "home");
    assert.strictEqual(normalizePublicHostname("203.0.113.7"), "203.0.113.7");
  });

  test("rejects empty values and anything that isn't just a hostname", () => {
    for (const value of [
      undefined,
      null,
      "",
      "   ",
      "https://my-pc.example.ts.net",
      "my-pc.example.ts.net:4747",
      "my-pc.example.ts.net/path",
      "my-pc.example.ts.net.",
      "-bad.example.com",
      "bad-.example.com",
      "under_score.example.com",
      "192.168.1",
      "256.1.1.1",
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
    ]) {
      assert.strictEqual(normalizePublicHostname(value), null, String(value));
    }
  });

  test("recognizes only in-range dotted-quad IPv4 literals", () => {
    assert.strictEqual(isIpv4Literal("100.64.0.1"), true);
    assert.strictEqual(isIpv4Literal("100.64.0"), false);
    assert.strictEqual(isIpv4Literal("100.64.0.256"), false);
    assert.strictEqual(isIpv4Literal("my-pc.example.ts.net"), false);
  });

  test("replaces only the host of a URL, keeping port, path and token", () => {
    assert.strictEqual(
      withUrlHostname(
        "https://192.168.1.4:4747/?token=secret",
        "my-pc.example.ts.net"
      ),
      "https://my-pc.example.ts.net:4747/?token=secret"
    );
    assert.strictEqual(withUrlHostname("not a url", "host"), "not a url");
  });

  test("matches the settings schema's pattern and length limit", () => {
    const settingsSchema = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../schemas/settings-schema.json"),
        "utf-8"
      )
    ) as {
      properties: {
        server: {
          properties: {
            publicHostname: { pattern: string; maxLength: number };
          };
        };
      };
    };
    const property = settingsSchema.properties.server.properties.publicHostname;
    assert.strictEqual(
      property.pattern,
      `^$|${PUBLIC_HOSTNAME_PATTERN_SOURCE}`
    );
    assert.strictEqual(property.maxLength, PUBLIC_HOSTNAME_MAX_LENGTH);
  });
});
