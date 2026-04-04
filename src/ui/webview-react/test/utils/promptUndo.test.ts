/**
 * Tests for promptUndo utilities.
 *
 * Strategy: construct realistic CliOutput structs with structured events and
 * WorkspaceSnapshot fixture data, then assert that the undo logic builds the
 * correct instructions.  No filesystem access is needed — the extension owns
 * the actual apply step; we only test the candidate/instruction derivation.
 */
import { describe, it, expect } from "vitest";
import {
  sameFilePath,
  getFileEventPaths,
  buildUndoCandidatesForOutputs,
  getPromptUndoSummary,
  buildUndoDialogInputForPrompt,
  buildUndoDialogInputForSpecificEvent,
} from "@utils/promptUndo";
import { CLI_EVENT_TYPES, OPERATION_STATUS } from "@/types/cliEvents";
import { FINAL_PROMPT_PHASES } from "@/types/messages";
import type { CliOutput } from "@/types/cliEvents";
import type {
  WorkspaceSnapshot,
  SnapshotFileChange,
} from "@root/types/OutputHistoryTypes";
import type { UnifiedDiffHunk } from "@/types/cliEvents";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

const PATCH: UnifiedDiffHunk[] = [
  {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: ["-old content", "+new content"],
  },
];

function makeFileEditEvent(
  path: string,
  opts: {
    oldContent?: string;
    newContent?: string;
    structuredPatch?: UnifiedDiffHunk[];
    status?: string;
    success?: boolean;
  } = {}
) {
  return {
    type: CLI_EVENT_TYPES.FILE_EDIT,
    data: {
      path,
      oldContent: opts.oldContent ?? "old",
      newContent: opts.newContent ?? "new",
      structuredPatch: opts.structuredPatch ?? PATCH,
      status: opts.status ?? OPERATION_STATUS.COMPLETED,
      success: opts.success,
    },
  };
}

function makeFileWriteEvent(path: string, opts: { success?: boolean } = {}) {
  return {
    type: CLI_EVENT_TYPES.FILE_WRITE,
    data: { path, content: "created content", success: opts.success },
  };
}

function makeFileDeleteEvent(path: string) {
  return {
    type: CLI_EVENT_TYPES.FILE_DELETE,
    data: { path, success: true },
  };
}

function makeCliOutput(events: unknown[]): CliOutput {
  return {
    structured: {
      events: events as NonNullable<CliOutput["structured"]>["events"],
      metadata: {},
    },
  } as unknown as CliOutput;
}

function makeSnapshot(files: SnapshotFileChange[]): WorkspaceSnapshot {
  return { capturedAt: Date.now(), strategy: "git", changedFiles: files };
}

function makeModifiedSnap(path: string, patch = PATCH): SnapshotFileChange {
  return { path, changeType: "modified", structuredPatch: patch };
}

function makeCreatedSnap(path: string): SnapshotFileChange {
  return { path, changeType: "created" };
}

function makeDeletedSnap(path: string, content: string): SnapshotFileChange {
  return { path, changeType: "deleted", contentToRestore: content };
}

const TARGET = { kind: FINAL_PROMPT_PHASES.QUEUE, stepIndex: 0 };

// ─────────────────────────────────────────────────────────────────────────────
// sameFilePath
// ─────────────────────────────────────────────────────────────────────────────

describe("sameFilePath", () => {
  it("identical paths → true", () => {
    expect(sameFilePath("src/foo.ts", "src/foo.ts")).toBe(true);
  });

  it("case-insensitive match → true", () => {
    expect(sameFilePath("Src/Foo.TS", "src/foo.ts")).toBe(true);
  });

  it("backslash vs forward-slash → true", () => {
    expect(sameFilePath("src\\foo.ts", "src/foo.ts")).toBe(true);
  });

  it("absolute event path ending with relative snapshot path → true", () => {
    expect(sameFilePath("C:/dev/project/src/foo.ts", "src/foo.ts")).toBe(true);
  });

  it("relative is a suffix of absolute (reversed argument order) → true", () => {
    expect(sameFilePath("src/foo.ts", "C:/dev/project/src/foo.ts")).toBe(true);
  });

  it("completely different paths → false", () => {
    expect(sameFilePath("src/foo.ts", "src/bar.ts")).toBe(false);
  });

  it("same filename but different directories → false", () => {
    expect(sameFilePath("a/foo.ts", "b/foo.ts")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getFileEventPaths
// ─────────────────────────────────────────────────────────────────────────────

describe("getFileEventPaths", () => {
  it("returns empty set for no outputs", () => {
    expect(getFileEventPaths([])).toEqual(new Set());
  });

  it("collects FILE_EDIT paths", () => {
    const output = makeCliOutput([makeFileEditEvent("src/a.ts")]);
    expect(getFileEventPaths([output])).toContain("src/a.ts");
  });

  it("collects FILE_WRITE paths", () => {
    const output = makeCliOutput([makeFileWriteEvent("src/new.ts")]);
    expect(getFileEventPaths([output])).toContain("src/new.ts");
  });

  it("collects FILE_DELETE paths", () => {
    const output = makeCliOutput([makeFileDeleteEvent("src/old.ts")]);
    expect(getFileEventPaths([output])).toContain("src/old.ts");
  });

  it("skips non-file events (TEXT, BASH_COMMAND)", () => {
    const output = makeCliOutput([
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "hello" } },
      { type: CLI_EVENT_TYPES.BASH_COMMAND, data: { command: "ls" } },
    ]);
    expect(getFileEventPaths([output]).size).toBe(0);
  });

  it("deduplicates the same path across multiple events", () => {
    const output = makeCliOutput([
      makeFileEditEvent("src/a.ts"),
      makeFileEditEvent("src/a.ts"),
    ]);
    expect(getFileEventPaths([output]).size).toBe(1);
  });

  it("collects paths across multiple CliOutputs (initial + retries)", () => {
    const o1 = makeCliOutput([makeFileEditEvent("src/a.ts")]);
    const o2 = makeCliOutput([makeFileEditEvent("src/b.ts")]);
    const paths = getFileEventPaths([o1, o2]);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildUndoCandidatesForOutputs — Tier 1 (event-attributed)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildUndoCandidatesForOutputs — Tier 1", () => {
  it("FILE_EDIT with snapshot structuredPatch → reverse-patch instruction", () => {
    const output = makeCliOutput([makeFileEditEvent("src/a.ts")]);
    const snapshot = makeSnapshot([makeModifiedSnap("src/a.ts")]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.tier).toBe("tier1");
    expect(c.changeType).toBe("modified");
    expect(c.instruction?.action).toBe("reverse-patch");
  });

  it("FILE_WRITE → 'created' changeType, delete instruction", () => {
    const output = makeCliOutput([makeFileWriteEvent("src/new.ts")]);
    const snapshot = makeSnapshot([makeCreatedSnap("src/new.ts")]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.changeType).toBe("created");
    expect(c.instruction?.action).toBe("delete");
  });

  it("FILE_DELETE with snapshot contentToRestore → restore-content instruction", () => {
    const output = makeCliOutput([makeFileDeleteEvent("src/gone.ts")]);
    const snapshot = makeSnapshot([
      makeDeletedSnap("src/gone.ts", "original content"),
    ]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.changeType).toBe("deleted");
    expect(c.instruction?.action).toBe("restore-content");
  });

  it("FILE_DELETE without snapshot contentToRestore → null instruction (non-undoable)", () => {
    const output = makeCliOutput([makeFileDeleteEvent("src/gone.ts")]);
    // Snapshot has no contentToRestore
    const snapshot = makeSnapshot([
      { path: "src/gone.ts", changeType: "deleted" },
    ]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    expect(candidates[0].instruction).toBeNull();
  });

  it("no snapshot match → null instruction (can't undo without snapshot)", () => {
    const output = makeCliOutput([makeFileEditEvent("src/a.ts")]);
    const candidates = buildUndoCandidatesForOutputs([output], undefined);

    expect(candidates[0].instruction).toBeNull();
  });

  it("failed FILE_EDIT (success=false) → skipped, does not appear as tier1 or tier2", () => {
    // Only event is a failed edit — the file wasn't actually changed, so the
    // snapshot won't show it as modified either. Nothing to undo.
    const output = makeCliOutput([
      makeFileEditEvent("src/a.ts", { success: false }),
    ]);
    const candidates = buildUndoCandidatesForOutputs([output], undefined);
    expect(candidates).toHaveLength(0);
  });

  it("prior successful FILE_WRITE then failed FILE_EDIT → write stays in tier1", () => {
    // The write succeeded (file was created). The subsequent edit failed.
    // The created file should still be undoable via tier1 — the failed edit
    // must not wipe the accumulated state for that path.
    const output = makeCliOutput([
      makeFileWriteEvent("src/a.ts"),
      makeFileEditEvent("src/a.ts", { success: false }),
    ]);
    const snapshot = makeSnapshot([makeCreatedSnap("src/a.ts")]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].tier).toBe("tier1");
    expect(candidates[0].changeType).toBe("created");
    expect(candidates[0].instruction?.action).toBe("delete");
  });

  it("multiple edits to same file: first oldContent kept, last newContent wins", () => {
    const output = makeCliOutput([
      makeFileEditEvent("src/a.ts", {
        oldContent: "v1",
        newContent: "v2",
        structuredPatch: [],
      }),
      makeFileEditEvent("src/a.ts", {
        oldContent: "v2",
        newContent: "v3",
        structuredPatch: [],
      }),
    ]);
    const candidates = buildUndoCandidatesForOutputs([output], undefined);

    expect(candidates).toHaveLength(1);
    // oldContent = first edit's old (first-write-wins)
    // newContent = last edit's new (last-write-wins)
    // (only visible when no structuredPatch from snapshot — instruction may be null)
    expect(candidates[0].oldContent).toBe("v1");
    expect(candidates[0].newContent).toBe("v3");
  });

  it("FILE_WRITE followed by FILE_EDIT → changeType stays 'created'", () => {
    const output = makeCliOutput([
      makeFileWriteEvent("src/new.ts"),
      makeFileEditEvent("src/new.ts"),
    ]);
    const snapshot = makeSnapshot([makeCreatedSnap("src/new.ts")]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    expect(candidates[0].changeType).toBe("created");
  });

  it("absolute event path matched to relative snapshot path via sameFilePath", () => {
    const output = makeCliOutput([
      makeFileEditEvent("C:/dev/project/src/a.ts"),
    ]);
    const snapshot = makeSnapshot([makeModifiedSnap("src/a.ts")]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].instruction).not.toBeNull();
  });

  it("uses snapshot structuredPatch over per-event patches for display", () => {
    const snapPatch: UnifiedDiffHunk[] = [
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        lines: ["-snap old", "+snap new"],
      },
    ];
    const output = makeCliOutput([
      makeFileEditEvent("src/a.ts", { structuredPatch: PATCH }),
    ]);
    const snapshot = makeSnapshot([
      { ...makeModifiedSnap("src/a.ts"), structuredPatch: snapPatch },
    ]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    // Snapshot patch wins for display
    expect(candidates[0].structuredPatch).toEqual(snapPatch);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildUndoCandidatesForOutputs — Tier 2 (snapshot-only)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildUndoCandidatesForOutputs — Tier 2", () => {
  it("snapshot file with no matching event → tier2 candidate", () => {
    const output = makeCliOutput([makeFileEditEvent("src/a.ts")]);
    const snapshot = makeSnapshot([
      makeModifiedSnap("src/a.ts"),
      makeModifiedSnap("src/b.ts"), // no event for b.ts
    ]);
    const candidates = buildUndoCandidatesForOutputs([output], snapshot);

    const tier2 = candidates.filter((c) => c.tier === "tier2");
    expect(tier2).toHaveLength(1);
    expect(tier2[0].path).toBe("src/b.ts");
  });

  it("snapshot-only modified file without structuredPatch → null instruction", () => {
    const candidates = buildUndoCandidatesForOutputs(
      [],
      makeSnapshot([{ path: "src/x.ts", changeType: "modified" }])
    );
    expect(candidates[0].tier).toBe("tier2");
    expect(candidates[0].instruction).toBeNull();
  });

  it("snapshot-only created file → delete instruction", () => {
    const candidates = buildUndoCandidatesForOutputs(
      [],
      makeSnapshot([makeCreatedSnap("src/x.ts")])
    );
    expect(candidates[0].instruction?.action).toBe("delete");
  });

  it("snapshot-only deleted file with contentToRestore → restore-content instruction", () => {
    const candidates = buildUndoCandidatesForOutputs(
      [],
      makeSnapshot([makeDeletedSnap("src/x.ts", "restore me")])
    );
    expect(candidates[0].instruction?.action).toBe("restore-content");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPromptUndoSummary
// ─────────────────────────────────────────────────────────────────────────────

describe("getPromptUndoSummary", () => {
  it("returns zeros for empty candidates", () => {
    const s = getPromptUndoSummary([]);
    expect(s.undoableCount).toBe(0);
    expect(s.hasTier2).toBe(false);
    expect(s.hasNonUndoable).toBe(false);
  });

  it("counts only candidates with a non-null instruction", () => {
    const candidates = [
      {
        tier: "tier1" as const,
        instruction: { path: "a.ts", action: "delete" as const },
        path: "a.ts",
        changeType: "created" as const,
      },
      {
        tier: "tier1" as const,
        instruction: null,
        path: "b.ts",
        changeType: "modified" as const,
      },
    ];
    const s = getPromptUndoSummary(candidates);
    expect(s.undoableCount).toBe(1);
    expect(s.hasNonUndoable).toBe(true);
  });

  it("reports hasTier2 when any candidate is tier2", () => {
    const candidates = [
      {
        tier: "tier2" as const,
        instruction: null,
        path: "b.ts",
        changeType: "modified" as const,
      },
    ];
    expect(getPromptUndoSummary(candidates).hasTier2).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildUndoDialogInputForPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe("buildUndoDialogInputForPrompt", () => {
  it("sets scope to prompt mode with the correct target", () => {
    const result = buildUndoDialogInputForPrompt(
      TARGET,
      [],
      undefined,
      "/workspace"
    );
    expect(result.scope.mode).toBe("prompt");
    expect(result.scope.target).toEqual(TARGET);
  });

  it("splits tier1 and tier2 candidates into correct arrays", () => {
    const output = makeCliOutput([makeFileEditEvent("src/a.ts")]);
    const snapshot = makeSnapshot([
      makeModifiedSnap("src/a.ts"),
      makeModifiedSnap("src/b.ts"), // tier2
    ]);
    const result = buildUndoDialogInputForPrompt(
      TARGET,
      [output],
      snapshot,
      "/workspace"
    );

    expect(result.eventAttributedFiles).toHaveLength(1);
    expect(result.eventAttributedFiles[0].path).toBe("src/a.ts");
    expect(result.snapshotOnlyFiles).toHaveLength(1);
    expect(result.snapshotOnlyFiles[0].path).toBe("src/b.ts");
  });

  it("includes workspacePath", () => {
    const result = buildUndoDialogInputForPrompt(
      TARGET,
      [],
      undefined,
      "/my/workspace"
    );
    expect(result.workspacePath).toBe("/my/workspace");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildUndoDialogInputForSpecificEvent
// ─────────────────────────────────────────────────────────────────────────────

describe("buildUndoDialogInputForSpecificEvent", () => {
  it("sets scope to singleFile mode", () => {
    const events = [makeFileEditEvent("src/a.ts")];
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      0,
      "src/a.ts",
      events as never,
      undefined,
      "/workspace"
    );
    expect(result.scope.mode).toBe("singleFile");
    expect((result.scope as { path: string }).path).toBe("src/a.ts");
  });

  it("FILE_EDIT with structuredPatch → reverse-patch instruction", () => {
    const events = [makeFileEditEvent("src/a.ts", { structuredPatch: PATCH })];
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      0,
      "src/a.ts",
      events as never,
      undefined,
      "/workspace"
    );
    expect(result.eventAttributedFiles[0].instruction?.action).toBe(
      "reverse-patch"
    );
  });

  it("FILE_EDIT without structuredPatch → null instruction (can't undo specific edit)", () => {
    const events = [makeFileEditEvent("src/a.ts", { structuredPatch: [] })];
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      0,
      "src/a.ts",
      events as never,
      undefined,
      "/workspace"
    );
    expect(result.eventAttributedFiles[0].instruction).toBeNull();
  });

  it("FILE_WRITE → delete instruction", () => {
    const events = [makeFileWriteEvent("src/new.ts")];
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      0,
      "src/new.ts",
      events as never,
      undefined,
      "/workspace"
    );
    expect(result.eventAttributedFiles[0].instruction?.action).toBe("delete");
  });

  it("FILE_DELETE with snapshot contentToRestore → restore-content instruction", () => {
    const events = [makeFileDeleteEvent("src/gone.ts")];
    const snapshot = makeSnapshot([makeDeletedSnap("src/gone.ts", "original")]);
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      0,
      "src/gone.ts",
      events as never,
      snapshot,
      "/workspace"
    );
    expect(result.eventAttributedFiles[0].instruction?.action).toBe(
      "restore-content"
    );
  });

  it("FILE_DELETE without snapshot → null instruction", () => {
    const events = [makeFileDeleteEvent("src/gone.ts")];
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      0,
      "src/gone.ts",
      events as never,
      undefined,
      "/workspace"
    );
    expect(result.eventAttributedFiles[0].instruction).toBeNull();
  });

  it("invalid event index → empty candidates", () => {
    const events = [makeFileEditEvent("src/a.ts")];
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      99,
      "src/a.ts",
      events as never,
      undefined,
      "/workspace"
    );
    expect(result.eventAttributedFiles).toHaveLength(0);
    expect(result.snapshotOnlyFiles).toHaveLength(0);
  });

  it("non-file event type → empty candidates", () => {
    const events = [{ type: CLI_EVENT_TYPES.TEXT, data: { text: "hello" } }];
    const result = buildUndoDialogInputForSpecificEvent(
      TARGET,
      0,
      "src/a.ts",
      events as never,
      undefined,
      "/workspace"
    );
    expect(result.eventAttributedFiles).toHaveLength(0);
  });
});
