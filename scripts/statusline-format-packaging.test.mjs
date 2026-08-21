import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const WRAPPER_PATH = path.join(
  ROOT_DIR,
  "out",
  "scripts",
  "ctrlyoke-statusline-wrapper.js"
);
const FORMAT_PATH = path.join(
  ROOT_DIR,
  "out",
  "scripts",
  "ctrlyoke-statusline-format.js"
);

test("packages the shared statusline formatter beside the detached wrapper", async () => {
  await fs.access(FORMAT_PATH);

  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const wrapper = require(process.argv[1]); process.stdout.write(String(wrapper.formatUsagePercentForDisplay(37, 'remaining')))",
        WRAPPER_PATH,
      ],
      {
        cwd: ROOT_DIR,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    );
    const output = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, stdout: Buffer.concat(output).toString("utf8") })
    );
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "63");
});
