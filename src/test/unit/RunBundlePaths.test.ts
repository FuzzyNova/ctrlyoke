/**
 * RunBundlePaths — the one transform that makes a run bundle portable.
 *
 * Every spelling below was seen in a real run's events.jsonl: harnesses write
 * the workspace as `C:\dev\x`, `c:\dev\x` and `C:/dev/x` in the same run, and
 * links in response text carry `#L12-L40` fragments and trailing `)`.
 */
import * as assert from "assert";
import { suite, test } from "mocha";
import {
  createPortablePathRewriter,
  createWorkspacePathResolver,
  isExternalAbsolutePath,
  mapJsonStrings,
} from "../../utils/RunBundlePaths";

suite("RunBundlePaths", () => {
  const windows = createPortablePathRewriter({
    workspaceRoot: "C:\\dev\\demo-app",
    homeDir: "C:\\Users\\someone",
  });

  test("rewrites every spelling of a drive-rooted workspace", () => {
    const cases: Array<[string, string]> = [
      ["C:\\dev\\demo-app", "${workspaceFolder}"],
      ["c:\\dev\\demo-app\\src\\a.ts", "${workspaceFolder}/src/a.ts"],
      [
        "C:/dev/demo-app/tests/notes.test.ts",
        "${workspaceFolder}/tests/notes.test.ts",
      ],
      ["C:\\\\dev\\\\demo-app\\\\src", "${workspaceFolder}/src"],
      [
        "file:///c%3A/dev/demo-app/README.md",
        "file:///${workspaceFolder}/README.md",
      ],
      ["cd /c/dev/demo-app/src && ls", "cd ${workspaceFolder}/src && ls"],
      ["C:\\DEV\\Demo-App\\x", "${workspaceFolder}/x"],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(windows(input), expected, input);
    }
  });

  test("stops at the delimiters that end a path in prose and Markdown", () => {
    assert.strictEqual(
      windows(
        "see [notes](C:/dev/demo-app/src/notes.ts#L14-L148), then `C:\\dev\\demo-app\\a.ts`."
      ),
      "see [notes](${workspaceFolder}/src/notes.ts#L14-L148), then `${workspaceFolder}/a.ts`."
    );
    assert.strictEqual(
      windows('"workingDirectory":"c:\\dev\\demo-app","x":1'),
      '"workingDirectory":"${workspaceFolder}","x":1'
    );
  });

  test("leaves a sibling directory that only shares a prefix", () => {
    assert.strictEqual(
      windows("C:\\dev\\demo-app2\\a.ts"),
      "C:\\dev\\demo-app2\\a.ts"
    );
    assert.strictEqual(
      windows("D:\\dev\\demo-app\\a.ts"),
      "D:\\dev\\demo-app\\a.ts"
    );
  });

  test("rewrites the home directory to ~ outside the workspace", () => {
    assert.strictEqual(
      windows("C:\\Users\\someone\\.vscode\\extensions\\x\\out\\cli.js"),
      "~/.vscode/extensions/x/out/cli.js"
    );
  });

  test("finds a path between ANSI escapes", () => {
    assert.strictEqual(
      windows("v2.1.9 \u001b[39m\u001b[90mC:/dev/demo-app\u001b[39m\n"),
      "v2.1.9 \u001b[39m\u001b[90m${workspaceFolder}\u001b[39m\n"
    );
    assert.strictEqual(windows("xC:\\dev\\demo-app"), "xC:\\dev\\demo-app");
  });

  test("scrubs the user name from a home path a shell flattened", () => {
    assert.strictEqual(
      windows("cat: 'C:UserssomeoneAppDataLocalTemp\\x.output': No such file"),
      "cat: 'C:Users<user>AppDataLocalTemp\\x.output': No such file"
    );
    assert.strictEqual(windows("C:\\users\\SOMEONE\\x"), "~/x");
    assert.strictEqual(windows("C:Userssomeoneelse"), "C:Userssomeoneelse");
  });

  test("prefers the workspace when it lives under the home directory", () => {
    const nested = createPortablePathRewriter({
      workspaceRoot: "/home/someone/src/app",
      homeDir: "/home/someone",
    });
    assert.strictEqual(
      nested("/home/someone/src/app/a.ts"),
      "${workspaceFolder}/a.ts"
    );
    assert.strictEqual(nested("/home/someone/.config/x"), "~/.config/x");
    // Not the workspace; only the user name goes.
    assert.strictEqual(
      nested("/mnt/home/someone/src/app/a.ts"),
      "/mnt/home/<user>/src/app/a.ts"
    );
    // POSIX paths are case-sensitive, so this is not the workspace; the user
    // name scrub still applies in any case.
    assert.strictEqual(nested("/Home/someone/src/app"), "/Home/<user>/src/app");
  });

  test("resolves the workspace token onto the loading workspace", () => {
    const resolve = createWorkspacePathResolver("D:\\work\\demo-app\\");
    assert.strictEqual(resolve("${workspaceFolder}"), "D:/work/demo-app");
    assert.strictEqual(
      resolve("open ${workspaceFolder}/src/a.ts#L3 and ~/.config/x"),
      "open D:/work/demo-app/src/a.ts#L3 and ~/.config/x"
    );
    const native = createWorkspacePathResolver("D:\\work\\demo-app", "\\");
    assert.strictEqual(
      native("${workspaceFolder}/src/a.ts"),
      "D:\\work\\demo-app\\src\\a.ts"
    );
  });

  test("round-trips a path through export and load", () => {
    const resolve = createWorkspacePathResolver("/srv/demo-app");
    assert.strictEqual(
      resolve(windows("C:\\dev\\demo-app\\src\\a.ts")),
      "/srv/demo-app/src/a.ts"
    );
  });

  test("maps every string in a JSON value without mutating it", () => {
    const input = {
      a: "C:\\dev\\demo-app",
      list: ["x", { b: "c:/dev/demo-app/y" }],
      n: 1,
      z: null,
    };
    const output = mapJsonStrings(input, windows);
    assert.deepStrictEqual(output, {
      a: "${workspaceFolder}",
      list: ["x", { b: "${workspaceFolder}/y" }],
      n: 1,
      z: null,
    });
    assert.strictEqual(input.a, "C:\\dev\\demo-app");
  });

  test("recognizes what is still absolute after the rewrite", () => {
    assert.ok(isExternalAbsolutePath("D:\\other\\notes.md"));
    assert.ok(isExternalAbsolutePath("/etc/hosts"));
    assert.ok(!isExternalAbsolutePath("${workspaceFolder}/a.ts"));
    assert.ok(!isExternalAbsolutePath("~/.config/x"));
    assert.ok(!isExternalAbsolutePath("src/a.ts"));
  });
});
