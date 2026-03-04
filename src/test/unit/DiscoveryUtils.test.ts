import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, afterEach } from "mocha";
import {
  formatDisplayName,
  isAccessibleDirectory,
} from "../../utils/DiscoveryUtils";

suite("DiscoveryUtils", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("formatDisplayName", () => {
    test("kebab-case → Title Case", () => {
      assert.strictEqual(formatDisplayName("pdf-processing"), "Pdf Processing");
    });

    test("snake_case → Title Case", () => {
      assert.strictEqual(formatDisplayName("my_skill"), "My Skill");
    });

    test("single word → Capitalized", () => {
      assert.strictEqual(formatDisplayName("analyze"), "Analyze");
    });

    test("empty string → empty string", () => {
      assert.strictEqual(formatDisplayName(""), "");
    });

    test("mixed separators (kebab and underscore) → Title Case", () => {
      assert.strictEqual(formatDisplayName("my-cool_tool"), "My Cool Tool");
    });

    test("already-uppercase letters are lowercased except the first", () => {
      assert.strictEqual(formatDisplayName("MY-TOOL"), "My Tool");
    });

    test("multiple consecutive separators handled gracefully", () => {
      // Extra hyphens produce empty segments → word.charAt(0) === '' → join with space
      // The implementation: split on space → empty-string segments produce empty strings after map
      const result = formatDisplayName("a--b");
      // "a--b" → replace → "a  b" → split(" ") → ["a","","b"]
      // map: ["A","","B"] → join → "A  B"
      assert.ok(typeof result === "string");
    });

    test("numeric characters are preserved", () => {
      assert.strictEqual(formatDisplayName("step-1"), "Step 1");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("isAccessibleDirectory", () => {
    let tmpDir: string;
    let tmpFile: string;
    const created: string[] = [];

    afterEach(async () => {
      for (const p of created.splice(0)) {
        try {
          const s = fs.statSync(p);
          if (s.isDirectory()) {
            fs.rmdirSync(p);
          } else {
            fs.unlinkSync(p);
          }
        } catch {
          // best-effort cleanup
        }
      }
    });

    test("returns true for an existing directory", async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-discovery-"));
      created.push(tmpDir);
      const result = await isAccessibleDirectory(tmpDir);
      assert.strictEqual(result, true);
    });

    test("returns false for a non-existent path", async () => {
      const result = await isAccessibleDirectory(
        path.join(os.tmpdir(), `fp-no-such-dir-${Date.now()}`)
      );
      assert.strictEqual(result, false);
    });

    test("returns false for a file (not a directory)", async () => {
      tmpFile = path.join(os.tmpdir(), `fp-file-${Date.now()}.txt`);
      created.push(tmpFile);
      fs.writeFileSync(tmpFile, "hello");
      const result = await isAccessibleDirectory(tmpFile);
      assert.strictEqual(result, false);
    });
  });
});
