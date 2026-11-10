import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import type { IHarnessAdapter } from "../../core/harness/shared/interfaces/IHarnessAdapter";
import { RunImportPreviewService } from "../../core/orchestration/RunImportPreview";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

suite("RunImportPreview", () => {
  let root: string;
  let bundle: string;
  let workspace: string;

  setup(async () => {
    root = makeTempDir("ctrlyoke-run-import-preview-");
    bundle = path.join(root, "fixture.ctrlyokerun");
    workspace = path.join(root, "workspace");
    await fs.mkdir(bundle, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await writeBundle(bundle);
  });

  teardown(() => removeTempDir(root));

  test("previews pending work, local resolution, trust, redaction, sessions and base blockers without writing", async () => {
    const service = new RunImportPreviewService();
    const preview = await service.preview(bundle, workspace, {
      createProvider: () =>
        ({
          probeResumableSession: async (id: string) =>
            id === "not-found-session" ? "missing" : "available",
        }) as unknown as IHarnessAdapter,
      git: async (_root, args) => {
        if (args[0] === "cat-file") throw new Error("missing");
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "another-commit";
        return "";
      },
      isSecretApproved: (_root, name) => name !== "DEPLOY_TOKEN",
    });

    assert.strictEqual(preview.continuable, true);
    assert.strictEqual(preview.continuation?.baseCommit.exists, false);
    assert.strictEqual(
      preview.continuation?.baseCommit.instruction,
      "push/fetch commit abcdef0"
    );
    assert.strictEqual(preview.continuation?.patchFileCount, 3);
    assert.deepStrictEqual(preview.warnings, [
      "2 values in changes.patch were redacted; those lines will contain [REDACTED] in the continued checkout.",
    ]);
    assert.strictEqual(preview.blockers[0]?.code, "base-commit-missing");
    assert.strictEqual(preview.pendingSteps.length, 4);
    assert.strictEqual(preview.pendingSteps[0]?.promptRedacted, true);
    assert.strictEqual(
      preview.pendingSteps[0]?.previouslyUsed?.harness,
      "claude-cli"
    );
    assert.strictEqual(preview.pendingSteps[0]?.harness, "codex-cli");
    assert.strictEqual(
      preview.pendingSteps[0]?.secretGrants[0]?.approved,
      false
    );
    assert.strictEqual(preview.pendingSteps[1]?.kind, "script");
    assert.strictEqual(
      preview.pendingSteps[1]?.script?.script,
      "npm run verify"
    );
    assert.deepStrictEqual(
      preview.sessions.map((session) => session.availability),
      ["missing", "malformed", "available"]
    );
    assert.strictEqual(preview.sessions[2]?.notFromThisRun, true);
    assert.match(preview.sessions[2]?.hint ?? "", /reply-to-step/);
    assert.strictEqual(preview.blockers[1]?.code, "missing-asset");
    assert.strictEqual(preview.blockers[1]?.stepIndex, 3);
    assert.strictEqual(
      await fs.readdir(workspace).then((entries) => entries.length),
      0
    );
  });
});

async function writeBundle(bundleDir: string): Promise<void> {
  const steps = [
    {
      prompt: "Deploy with [REDACTED]",
      harness: "codex-cli",
      resumeSession: true,
      sessionId: "not-found-session",
      secrets: ["DEPLOY_TOKEN"],
      additionalArgs: "--fast",
      mcpServers: ["github"],
      preCondition: { script: "npm run ready" },
      endCondition: { script: "npm test" },
      _runtime: {
        sessionId: "not-found-session",
        harness: "claude-cli",
        model: "old-model",
      },
    },
    { type: "script", script: "npm run verify", _runtime: {} },
    {
      prompt: "Check malformed",
      harness: "claude-cli",
      resumeSession: true,
      sessionId: "malformed",
      _runtime: {},
    },
    {
      prompt: "One more pending @.ctrlyoke/attachments/absent.txt",
      harness: "codex-cli",
      model: "local-model",
      resumeSession: true,
      sessionId: "unrelated-session",
      priorContext: "none",
      _runtime: {},
    },
  ];
  await fs.writeFile(
    path.join(bundleDir, "run.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "ctrlyoke.run.bundle",
      exportedAt: "2026-10-31T12:00:00.000Z",
      exportedByVersion: "0.4.1",
      sourceRoot: "~/source",
      lineage: { workflowName: "Preview fixture" },
      provenance: {
        workflowKey: "source-workflow",
        runRef: "run-source",
        runId: 1,
        steps: [
          {
            stepIndex: 0,
            harness: "claude-cli",
            model: "old-model",
            sessionId: "not-found-session",
          },
        ],
      },
      includesSnapshots: false,
      redaction: {
        policy: "secrets-v1",
        removedCount: 1,
        byRule: {},
        byFile: { "run.ctrlyoke.json": 1, "changes.patch": 2 },
      },
      externalPaths: [],
      continuation: {
        executionState: "stopped",
        nextStep: { kind: "queue", stepIndex: 0 },
        pendingStepCount: 4,
        worktreeMode: "managed",
        workspace: {
          baseCommit: "abcdef0123456789",
          branch: "feature",
          patch: {
            file: "changes.patch",
            sha256:
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            files: 3,
            binary: 0,
          },
        },
      },
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(bundleDir, "workflow.ctrlyoke.json"),
    JSON.stringify({ steps }),
    "utf8"
  );
  await fs.writeFile(
    path.join(bundleDir, "run.ctrlyoke.json"),
    JSON.stringify({ steps, _runtime: { currentIndex: 0 } }),
    "utf8"
  );
  await fs.writeFile(
    path.join(bundleDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 2,
      storageKind: "timeline",
      runId: 1,
      startedAt: 1,
      nextSequence: 1,
      eventCount: 0,
    }),
    "utf8"
  );
  await fs.writeFile(path.join(bundleDir, "events.jsonl"), "", "utf8");
  await fs.writeFile(path.join(bundleDir, "changes.patch"), "", "utf8");
}
