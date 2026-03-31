import * as path from "path";
import Mocha from "mocha";
import { glob } from "glob";

export function run(): Promise<void> {
  // Create the mocha test
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
  });

  const testsRoot = path.resolve(__dirname, "..");

  return new Promise((c, e) => {
    // Harness integration tests (src/test/harness/) run separately via
    // `npm run test:harness` — they invoke real AI CLIs and need long
    // timeouts that aren't compatible with the VS Code extension host.
    const testFiles = new glob.Glob("**/**.test.js", {
      cwd: testsRoot,
      ignore: ["harness/**"],
    });
    const testFileStream = testFiles.stream();

    testFileStream.on("data", (file) => {
      mocha.addFile(path.resolve(testsRoot, file));
    });
    testFileStream.on("error", (err) => {
      e(err);
    });
    testFileStream.on("end", () => {
      try {
        // Run the mocha test
        mocha.run((failures: number) => {
          if (failures > 0) {
            e(new Error(`${failures} tests failed.`));
          } else {
            c();
          }
        });
      } catch (err) {
        console.error(err);
        e(err);
      }
    });
  });
}
