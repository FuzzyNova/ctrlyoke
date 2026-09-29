import * as assert from "assert";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import {
  isPathWithinDirectory,
  isPathWithinAnyDirectory,
} from "../../utils/PathSecurity";

suite("PathSecurity", () => {
  suite("isPathWithinDirectory", () => {
    test("accepts the directory itself and descendants", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(isPathWithinDirectory(dir, dir), true);
      assert.strictEqual(
        isPathWithinDirectory(path.join(dir, "src", "a.ts"), dir),
        true
      );
    });

    test("rejects a sibling-prefix path (CVE-style bypass)", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      const sibling = path.join("C:", "dev", "ctrlyoke-evil", "payload.ps1");
      assert.strictEqual(isPathWithinDirectory(sibling, dir), false);
    });

    test("accepts descendants of a drive root on win32, case-insensitively", function () {
      if (path.sep !== "\\") {
        this.skip();
      }

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      try {
        assert.strictEqual(
          isPathWithinDirectory("c:\\foo\\bar.txt", "C:\\"),
          true
        );
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          configurable: true,
        });
      }
    });

    test("accepts descendants of the POSIX root when path.sep is '/'", function () {
      if (path.sep !== "/") {
        this.skip();
      }

      assert.strictEqual(isPathWithinDirectory("/foo/bar.txt", "/"), true);
    });

    test("rejects the parent directory", () => {
      const dir = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(
        isPathWithinDirectory(path.join("C:", "dev"), dir),
        false
      );
    });

    suite("case folding (win32 filesystem semantics)", () => {
      const originalPlatform = process.platform;

      function setPlatform(value: NodeJS.Platform): void {
        Object.defineProperty(process, "platform", {
          value,
          configurable: true,
        });
      }

      teardown(() => {
        setPlatform(originalPlatform);
      });

      // Case variants are produced by re-casing the whole joined path: letters
      // change, `path.sep` does not — so these stay correct on every OS. Do not
      // hardcode separators here; `isPathWithinDirectory` reads the real
      // `path.sep`, which does not follow the stubbed `process.platform`.
      const dir = path.join("C:", "dev", "ctrlyoke");
      const descendant = path.join(dir, "src", "a.ts");

      test("win32: accepts a descendant whose drive letter case differs", () => {
        setPlatform("win32");
        // The exact shape that broke us: VS Code reports a lowercase drive
        // letter, Node/git report the OS-native uppercase one.
        assert.strictEqual(
          isPathWithinDirectory(descendant.toLowerCase(), dir),
          true
        );
        assert.strictEqual(isPathWithinDirectory(dir.toLowerCase(), dir), true);
      });

      test("win32: accepts differing case in interior segments", () => {
        setPlatform("win32");
        assert.strictEqual(
          isPathWithinDirectory(descendant.toUpperCase(), dir),
          true
        );
      });

      test("win32: still rejects a sibling-prefix path regardless of case", () => {
        setPlatform("win32");
        const sibling = path.join("C:", "dev", "ctrlyoke-evil", "payload.ps1");
        assert.strictEqual(
          isPathWithinDirectory(sibling.toUpperCase(), dir),
          false
        );
        assert.strictEqual(
          isPathWithinDirectory(sibling.toLowerCase(), dir),
          false
        );
      });

      test("win32: still rejects the parent directory regardless of case", () => {
        setPlatform("win32");
        assert.strictEqual(
          isPathWithinDirectory(path.join("C:", "dev").toLowerCase(), dir),
          false
        );
      });

      test("non-win32: stays case-sensitive", () => {
        setPlatform("linux");
        assert.strictEqual(
          isPathWithinDirectory(descendant.toUpperCase(), dir),
          false
        );
        assert.strictEqual(isPathWithinDirectory(descendant, dir), true);
      });
    });
  });

  suite("isPathWithinAnyDirectory", () => {
    const frontend = path.resolve("/repos/frontend");
    const backend = path.resolve("/other/backend");

    test("accepts a path under any of several trusted roots", () => {
      assert.strictEqual(
        isPathWithinAnyDirectory(path.join(frontend, "src", "a.ts"), [
          frontend,
          backend,
        ]),
        true
      );
      assert.strictEqual(
        isPathWithinAnyDirectory(path.join(backend, "src", "b.ts"), [
          frontend,
          backend,
        ]),
        true
      );
    });

    test("rejects a path outside every trusted root", () => {
      const outside = path.resolve("/elsewhere/secret.txt");
      assert.strictEqual(
        isPathWithinAnyDirectory(outside, [frontend, backend]),
        false
      );
    });

    test("rejects a sibling-prefix path against every trusted root", () => {
      const sibling = path.resolve("/repos/frontend-evil/payload.sh");
      assert.strictEqual(
        isPathWithinAnyDirectory(sibling, [frontend, backend]),
        false
      );
    });

    test("returns false for an empty trusted-roots list", () => {
      assert.strictEqual(
        isPathWithinAnyDirectory(path.join(frontend, "a.ts"), []),
        false
      );
    });
  });
});
