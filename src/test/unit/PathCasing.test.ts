import * as assert from "assert";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import {
  foldPathForCompare,
  pathsEqual,
  canonicalizeDriveLetter,
  canonicalizeSpawnCwd,
  lowercaseDriveLetter,
} from "../../utils/PathCasing";

suite("PathCasing", () => {
  const originalPlatform = process.platform;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }

  teardown(() => {
    setPlatform(originalPlatform);
  });

  suite("foldPathForCompare", () => {
    test("lowercases on win32", () => {
      setPlatform("win32");
      assert.strictEqual(foldPathForCompare("C:\\Dev\\X.TS"), "c:\\dev\\x.ts");
    });

    test("is a no-op off win32", () => {
      setPlatform("linux");
      assert.strictEqual(foldPathForCompare("/Repos/X.ts"), "/Repos/X.ts");
    });

    test("preserves length so callers can slice by prefix", () => {
      setPlatform("win32");
      const value = path.join("C:", "dev", "CtrlYoke");
      assert.strictEqual(foldPathForCompare(value).length, value.length);
    });
  });

  suite("pathsEqual", () => {
    test("win32: ignores drive-letter and segment case", () => {
      setPlatform("win32");
      const dir = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(pathsEqual(dir.toLowerCase(), dir), true);
      assert.strictEqual(pathsEqual(dir.toUpperCase(), dir), true);
    });

    test("win32: still distinguishes genuinely different paths", () => {
      setPlatform("win32");
      assert.strictEqual(
        pathsEqual(path.join("C:", "dev", "a"), path.join("C:", "dev", "b")),
        false
      );
    });

    test("non-win32: stays case-sensitive", () => {
      setPlatform("linux");
      const dir = path.join("C:", "dev", "ctrlyoke");
      assert.strictEqual(pathsEqual(dir.toLowerCase(), dir), false);
      assert.strictEqual(pathsEqual(dir, dir), true);
    });
  });

  suite("canonicalizeDriveLetter", () => {
    test("uppercases a lowercase drive letter on win32", () => {
      setPlatform("win32");
      // The regression this exists for: a lowercase-drive cwd made Vitest
      // resolve a duplicate copy of itself and fail every suite.
      assert.strictEqual(
        canonicalizeDriveLetter("c:\\dev\\ctrlyoke"),
        "C:\\dev\\ctrlyoke"
      );
      assert.strictEqual(
        canonicalizeDriveLetter("c:/dev/ctrlyoke"),
        "C:/dev/ctrlyoke"
      );
    });

    test("is idempotent and leaves an uppercase drive alone", () => {
      setPlatform("win32");
      const once = canonicalizeDriveLetter("c:\\dev");
      assert.strictEqual(canonicalizeDriveLetter(once), once);
      assert.strictEqual(canonicalizeDriveLetter("C:\\dev"), "C:\\dev");
    });

    test("leaves non-drive-rooted paths untouched on win32", () => {
      setPlatform("win32");
      // UNC, relative, and bare drive references have no separator to anchor on.
      assert.strictEqual(
        canonicalizeDriveLetter("\\\\server\\share\\x"),
        "\\\\server\\share\\x"
      );
      assert.strictEqual(canonicalizeDriveLetter("src\\a.ts"), "src\\a.ts");
      assert.strictEqual(canonicalizeDriveLetter("c:relative"), "c:relative");
    });

    test("is a no-op off win32", () => {
      setPlatform("linux");
      assert.strictEqual(canonicalizeDriveLetter("c:/dev"), "c:/dev");
      assert.strictEqual(canonicalizeDriveLetter("/repos/x"), "/repos/x");
    });
  });

  suite("canonicalizeSpawnCwd", () => {
    test("passes undefined through for `?? fallback` chains", () => {
      setPlatform("win32");
      assert.strictEqual(canonicalizeSpawnCwd(undefined), undefined);
    });

    test("canonicalizes a defined cwd", () => {
      setPlatform("win32");
      assert.strictEqual(canonicalizeSpawnCwd("c:\\dev"), "C:\\dev");
    });
  });

  suite("lowercaseDriveLetter", () => {
    test("lowercases regardless of platform, for stable serialized output", () => {
      // Not platform-gated on purpose: the generated hook file must be
      // byte-identical no matter which OS or launch mode wrote it.
      setPlatform("linux");
      assert.strictEqual(lowercaseDriveLetter("C:\\dev\\x"), "c:\\dev\\x");
      setPlatform("win32");
      assert.strictEqual(lowercaseDriveLetter("C:\\dev\\x"), "c:\\dev\\x");
    });

    test("is idempotent", () => {
      const once = lowercaseDriveLetter("C:/dev");
      assert.strictEqual(lowercaseDriveLetter(once), once);
    });
  });
});
