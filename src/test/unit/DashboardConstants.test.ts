import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";
import {
  QUEUE_POSITION,
  getHarnessDisplayName,
  getHarnessShortName,
  HARNESS_IDS,
  resolveQueueInsertIndex,
  IMAGE_REF_EXTENSIONS,
  imageExtensionToMimeType,
  isImageRefPath,
  WORKSPACE_MEDIA_INFO_BY_EXTENSION,
  WORKSPACE_MEDIA_KINDS,
  workspaceMediaInfoForPath,
  PROMPT_TERMINAL_STATUS,
  STEP_STATUS,
  isTerminalStepStatus,
  stepStatusForCompletedRuntime,
  VSCODE_COMMANDS,
  type PromptTerminalStatus,
  type StepStatus,
} from "../../types/DashboardConstants";

interface ExtensionManifest {
  contributes?: {
    commands?: Array<{ command: string }>;
  };
}

const PACKAGE_CONTRIBUTED_COMMAND_KEYS = [
  "OPEN_PANEL",
  "ENABLE_SERVER",
  "DISABLE_SERVER",
  "MANAGE_WORKTREES",
  "REFRESH_HARNESS_USAGE",
  "REFRESH_WORKSPACE_STATS",
  "REVIEW_WORKSPACE_SETTINGS_TRUST",
  "INSTALL_CLI",
  "ACTIVATE_PRO",
  "ACTIVATE_OFFLINE_PRO",
  "DEACTIVATE_PRO",
  "MANAGE_LICENSE",
  "SELECT_PROMPT_FILE",
  "SHOW_OUTPUT_PANEL",
  "ADD_EDITOR_COMMIT_TO_PROMPT_EDITOR",
  "SEARCH_HISTORY",
  "GENERATE_COMMIT_MESSAGE",
  "CANCEL_COMMIT_MESSAGE_GENERATION",
] as const satisfies readonly (keyof typeof VSCODE_COMMANDS)[];

suite("VSCODE_COMMANDS", () => {
  test("keeps unique values and contributed command IDs in sync with package.json", () => {
    const commandIds = Object.values(VSCODE_COMMANDS);
    assert.strictEqual(new Set(commandIds).size, commandIds.length);

    const manifestPath = path.resolve(__dirname, "../../../package.json");
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8")
    ) as ExtensionManifest;
    const contributedCommandIds = new Set(
      manifest.contributes?.commands?.map(({ command }) => command) ?? []
    );
    const contributedConstantKeys = Object.entries(VSCODE_COMMANDS)
      .filter(
        ([, commandId]) =>
          commandId.startsWith("ctrlyoke.") &&
          contributedCommandIds.has(commandId)
      )
      .map(([key]) => key)
      .sort();

    assert.deepStrictEqual(
      contributedConstantKeys,
      [...PACKAGE_CONTRIBUTED_COMMAND_KEYS].sort()
    );
    for (const key of PACKAGE_CONTRIBUTED_COMMAND_KEYS) {
      assert.ok(
        contributedCommandIds.has(VSCODE_COMMANDS[key]),
        `${key} (${VSCODE_COMMANDS[key]}) must match a package.json command`
      );
    }
  });
});

suite("isTerminalStepStatus", () => {
  test("recognizes every canonical prompt terminal status", () => {
    for (const status of Object.values(PROMPT_TERMINAL_STATUS)) {
      assert.strictEqual(isTerminalStepStatus(status), true);
    }
  });

  test("rejects non-terminal and non-string values", () => {
    assert.strictEqual(isTerminalStepStatus("running"), false);
    assert.strictEqual(isTerminalStepStatus(undefined), false);
    assert.strictEqual(isTerminalStepStatus(null), false);
  });
});

suite("stepStatusForCompletedRuntime", () => {
  const expectedStatuses: Record<PromptTerminalStatus, StepStatus> = {
    [PROMPT_TERMINAL_STATUS.COMPLETED]: STEP_STATUS.COMPLETED,
    [PROMPT_TERMINAL_STATUS.CANCELLED]: STEP_STATUS.CANCELLED,
    [PROMPT_TERMINAL_STATUS.FAILED]: STEP_STATUS.FAILED,
    [PROMPT_TERMINAL_STATUS.SKIPPED]: STEP_STATUS.SKIPPED,
    [PROMPT_TERMINAL_STATUS.NO_TURN_STARTED]: STEP_STATUS.NO_TURN_STARTED,
  };

  test("maps every recognized terminal status", () => {
    for (const terminalStatus of Object.values(PROMPT_TERMINAL_STATUS)) {
      assert.strictEqual(
        stepStatusForCompletedRuntime(terminalStatus),
        expectedStatuses[terminalStatus]
      );
    }
  });

  test("defaults missing and unknown terminal statuses to completed", () => {
    assert.strictEqual(
      stepStatusForCompletedRuntime(undefined),
      STEP_STATUS.COMPLETED
    );
    assert.strictEqual(
      stepStatusForCompletedRuntime("future-terminal-status"),
      STEP_STATUS.COMPLETED
    );
  });
});

suite("resolveQueueInsertIndex", () => {
  test("places parallelWithCurrent after the current live group", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
    ];

    assert.strictEqual(
      resolveQueueInsertIndex(
        QUEUE_POSITION.PARALLEL_WITH_CURRENT,
        2,
        7,
        parallelGroups
      ),
      4
    );
  });

  test("keeps next as an ordinary insertion inside a live group", () => {
    const parallelGroups = [
      { id: "group-1", startIndex: 1, endIndex: 3, failFast: false },
    ];

    assert.strictEqual(
      resolveQueueInsertIndex(QUEUE_POSITION.NEXT, 2, 7, parallelGroups),
      3
    );
  });
});

suite("harness display labels", () => {
  test("fall back to an unknown harness id", () => {
    assert.strictEqual(getHarnessDisplayName("unknown-cli"), "unknown-cli");
    assert.strictEqual(getHarnessShortName("unknown-cli"), "unknown-cli");
  });

  test("use the configured labels for known harness ids", () => {
    assert.strictEqual(getHarnessDisplayName(HARNESS_IDS.CODEX_CLI), "Codex");
    assert.strictEqual(getHarnessShortName(HARNESS_IDS.CODEX_CLI), "Codex");
  });
});

suite("workspace media classification", () => {
  test("classifies every allowlisted extension with its expected MIME type", () => {
    const expected: Record<string, { mediaKind: string; mimeType: string }> = {
      mp4: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/mp4" },
      m4v: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/mp4" },
      webm: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/webm" },
      ogv: { mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO, mimeType: "video/ogg" },
      mov: {
        mediaKind: WORKSPACE_MEDIA_KINDS.VIDEO,
        mimeType: "video/quicktime",
      },
      mp3: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/mpeg" },
      m4a: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/mp4" },
      aac: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/aac" },
      wav: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/wav" },
      flac: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/flac" },
      ogg: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/ogg" },
      oga: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/ogg" },
      opus: { mediaKind: WORKSPACE_MEDIA_KINDS.AUDIO, mimeType: "audio/ogg" },
      pdf: {
        mediaKind: WORKSPACE_MEDIA_KINDS.PDF,
        mimeType: "application/pdf",
      },
    };
    for (const [extension, info] of Object.entries(expected)) {
      assert.deepStrictEqual(
        workspaceMediaInfoForPath(`asset.${extension}`),
        info
      );
      assert.deepStrictEqual(
        WORKSPACE_MEDIA_INFO_BY_EXTENSION[extension],
        info
      );
    }
    for (const extension of IMAGE_REF_EXTENSIONS) {
      const mimeType = imageExtensionToMimeType(extension);
      assert.ok(mimeType);
      const imageInfo = workspaceMediaInfoForPath(`asset.${extension}`);
      assert.deepStrictEqual(imageInfo, {
        mediaKind: WORKSPACE_MEDIA_KINDS.IMAGE,
        mimeType,
      });
    }
    assert.strictEqual(
      Object.keys(WORKSPACE_MEDIA_INFO_BY_EXTENSION).length,
      Object.keys(expected).length + IMAGE_REF_EXTENSIONS.length
    );
  });

  test("does not treat Object.prototype member names as media extensions", () => {
    for (const extension of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
    ]) {
      assert.strictEqual(
        workspaceMediaInfoForPath(`payload.${extension}`),
        undefined,
        extension
      );
    }
  });

  test("leaves isImageRefPath behavior intact", () => {
    for (const extension of IMAGE_REF_EXTENSIONS) {
      assert.strictEqual(isImageRefPath(`asset.${extension}`), true);
      assert.strictEqual(
        isImageRefPath(`asset.${extension.toUpperCase()}`),
        true
      );
    }
    for (const path of ["asset.svg", "asset.mp4", "asset", "asset.jpg.txt"]) {
      assert.strictEqual(isImageRefPath(path), false);
    }
  });
});
