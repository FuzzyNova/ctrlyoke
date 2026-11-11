import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensurePrivateDirectory } from "../../utils/PrivateFileModes";

suite("PrivateFileModes", () => {
  (process.platform === "win32" ? test.skip : test)(
    "tightens an existing directory to mode 0700",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-dir-"));
      const directory = path.join(root, "loose");
      try {
        await fs.mkdir(directory, { mode: 0o777 });
        await fs.chmod(directory, 0o777);
        await ensurePrivateDirectory(directory);
        const mode = (await fs.stat(directory)).mode & 0o777;
        assert.strictEqual(mode, 0o700);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
});
