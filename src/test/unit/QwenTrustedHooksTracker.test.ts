import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { QwenTrustedHooksTracker } from "../../core/harness/shared/QwenTrustedHooksTracker";

suite("QwenTrustedHooksTracker", () => {
  let tmpDir: string;
  let trustedHooksPath: string;
  let workspaceRoot: string;

  setup(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-trust-tracker-"));
    trustedHooksPath = path.join(tmpDir, "qwen", "trusted_hooks.json");
    workspaceRoot = path.join(tmpDir, "workspace");
    QwenTrustedHooksTracker.resetAll();
  });

  teardown(async () => {
    QwenTrustedHooksTracker.resetAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function tracker(): QwenTrustedHooksTracker {
    return QwenTrustedHooksTracker.getInstance({ trustedHooksPath });
  }

  async function readTrustFile(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(trustedHooksPath, "utf-8")) as Record<
      string,
      unknown
    >;
  }

  test("serializes simultaneous updates and preserves each workflow's key", async () => {
    await Promise.all([
      tracker().registerWorkflow("wf-a", workspaceRoot, [":hook-a"]),
      tracker().registerWorkflow("wf-b", workspaceRoot, [":hook-b"]),
    ]);

    const trustFile = await readTrustFile();
    assert.deepStrictEqual(trustFile[workspaceRoot], [":hook-a", ":hook-b"]);
  });

  test("preserves an external edit made while hooks are active", async () => {
    await tracker().registerWorkflow("wf-a", workspaceRoot, [":hook-a"]);

    const current = await readTrustFile();
    (current[workspaceRoot] as string[]).push(":user-added");
    await fs.writeFile(trustedHooksPath, JSON.stringify(current), "utf-8");

    await tracker().registerWorkflow("wf-b", workspaceRoot, [":hook-b"]);

    assert.deepStrictEqual((await readTrustFile())[workspaceRoot], [
      ":hook-a",
      ":user-added",
      ":hook-b",
    ]);
  });

  test("preserves pre-existing trust entries and unknown workspace entries", async () => {
    await fs.mkdir(path.dirname(trustedHooksPath), { recursive: true });
    const otherWorkspace = path.join(tmpDir, "other-workspace");
    await fs.writeFile(
      trustedHooksPath,
      JSON.stringify({
        [workspaceRoot]: [":already-trusted"],
        [otherWorkspace]: [":other-hook"],
      }),
      "utf-8"
    );

    await tracker().registerWorkflow("wf-a", workspaceRoot, [":new-hook"]);
    await tracker().unregisterWorkflow("wf-a");

    const trustFile = await readTrustFile();
    assert.deepStrictEqual(trustFile[workspaceRoot], [
      ":already-trusted",
      ":new-hook",
    ]);
    assert.deepStrictEqual(trustFile[otherWorkspace], [":other-hook"]);
  });

  test("reuses the workspace trust entry for env hooks across steps", async () => {
    const command =
      ':node "extension/out/scripts/ctrlyoke-hook-run.js" "state/temp/hook-environments/user-hook-env-run-123.json" hook-0 stop YQ==';

    await tracker().registerWorkflow("run-123-step-0", workspaceRoot, [], [command]);
    await tracker().registerWorkflow("run-123-step-1", workspaceRoot, [], [command]);

    assert.deepStrictEqual((await readTrustFile())[workspaceRoot], [command]);
  });

  test("reference-counts ctrlyoke keys by workflow key while retaining trust", async () => {
    const qwenTracker = tracker();
    await qwenTracker.registerWorkflow("wf-a", workspaceRoot, [":shared"]);
    await qwenTracker.registerWorkflow("wf-b", workspaceRoot, [":shared"]);

    assert.strictEqual(qwenTracker.getReferenceCount(":shared"), 2);
    await qwenTracker.unregisterWorkflow("wf-a");
    assert.strictEqual(qwenTracker.getReferenceCount(":shared"), 1);
    await qwenTracker.unregisterWorkflow("wf-b");
    assert.strictEqual(qwenTracker.getReferenceCount(":shared"), 0);
    assert.deepStrictEqual((await readTrustFile())[workspaceRoot], [":shared"]);
  });
});
