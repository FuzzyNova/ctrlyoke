import * as assert from "assert";
import type {
  BashCommandData,
  CliEvent,
  FileEditData,
} from "../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
} from "../../types/DashboardConstants";
import {
  findSupersededInitiatedIndex,
  shouldHideInitiatedFileEditDiff,
} from "../../utils/CliEventVisibility";

suite("CliEventVisibility", () => {
  test("finds an initiated Bash row superseded by its matching completion", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "npm test",
          status: OPERATION_STATUS.INITIATED,
        } as BashCommandData,
      },
      { type: CLI_EVENT_TYPES.TEXT, data: { text: "interleaved" } },
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "npm test",
          status: OPERATION_STATUS.COMPLETED,
        } as BashCommandData,
      },
    ];

    assert.strictEqual(findSupersededInitiatedIndex(events, 0), 0);
    assert.strictEqual(findSupersededInitiatedIndex(events, 1), undefined);
    assert.strictEqual(findSupersededInitiatedIndex(events, 2), undefined);
  });

  test("does not hide Bash rows with another command or an unpaired start", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "npm test",
          status: OPERATION_STATUS.INITIATED,
        } as BashCommandData,
      },
      {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
        data: {
          command: "npm run lint",
          status: OPERATION_STATUS.COMPLETED,
        } as BashCommandData,
      },
    ];

    assert.strictEqual(findSupersededInitiatedIndex(events, 0), undefined);
    assert.strictEqual(findSupersededInitiatedIndex(events, 1), undefined);
  });

  test("hides only an initiated FILE_EDIT diff with a matching completed path", () => {
    const events: CliEvent[] = [
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "src/example.ts",
          status: OPERATION_STATUS.INITIATED,
        } as FileEditData,
      },
      {
        type: CLI_EVENT_TYPES.FILE_EDIT,
        data: {
          path: "C:/repo/src/example.ts",
          status: OPERATION_STATUS.COMPLETED,
        } as FileEditData,
      },
    ];

    assert.strictEqual(shouldHideInitiatedFileEditDiff(events, 0), true);
    assert.strictEqual(shouldHideInitiatedFileEditDiff(events, 1), false);
  });
});
