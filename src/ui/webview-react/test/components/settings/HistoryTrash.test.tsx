import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClearHistoryModal } from "@components/settings/ClearHistoryModal";
import { RecentlyDeletedModal } from "@components/settings/RecentlyDeletedModal";
import { RunHistorySection } from "@components/settings/RunHistorySection";
import {
  TypedConfirmModal,
  matchesConfirmationPhrase,
} from "@components/shared/TypedConfirmModal";
import { useHistoryTrashStore } from "@store/historyTrashStore";
import { useUiStore } from "@store/uiStore";
import {
  CLEAR_HISTORY_CONFIRMATION_PHRASE,
  EMPTY_TRASH_CONFIRMATION_PHRASE,
  HISTORY_TRASH_ENTRY_KINDS,
  MESSAGE_TYPES,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { HistoryTrashEntrySummary } from "@root/types/HistoryTrashTypes";
import type { RunRef, WorkflowKey } from "@root/types/CtrlYokeTypes";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";

const postMessageSpy = vi.fn();
const DAY_MS = 24 * 60 * 60 * 1000;

function entry(
  overrides: Partial<HistoryTrashEntrySummary> = {}
): HistoryTrashEntrySummary {
  const deletedAt = Date.now() - 60 * 60 * 1000;
  return {
    schemaVersion: 1,
    id: "2026-09-30T00-00-00-000Z-aaaa0001",
    kind: HISTORY_TRASH_ENTRY_KINDS.RUN,
    deletedAt,
    requestedBy: "webview",
    items: [
      {
        workflowKey: "fix-bug-key" as WorkflowKey,
        workflowName: "Fix bug",
        wholeLineage: false,
        runRefs: ["run-2026-09-29T00-00-00-000Z" as RunRef],
        runIds: [12],
      },
    ],
    skippedLive: [],
    bytes: 2048,
    expiresAt: deletedAt + 30 * DAY_MS,
    ...overrides,
  };
}

function typePhrase(phrase: string) {
  fireEvent.change(screen.getByLabelText(/to confirm/i), {
    target: { value: phrase },
  });
}

beforeEach(() => {
  useHistoryTrashStore.setState({
    listing: undefined,
    clearPreview: undefined,
    pendingEntryIds: [],
  });
  useUiStore.getState().resetUi();
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

describe("TypedConfirmModal", () => {
  it("keeps confirm disabled until the phrase is typed, ignoring case and spaces", () => {
    const onConfirm = vi.fn();
    render(
      <TypedConfirmModal
        isOpen
        title="Danger"
        phrase="clear history"
        confirmLabel="Go"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      >
        <p>Body</p>
      </TypedConfirmModal>
    );

    const confirm = screen.getByRole("button", { name: "Go" });
    expect(confirm).toBeDisabled();
    typePhrase("clear");
    expect(confirm).toBeDisabled();
    // iOS capitalizes the first letter on its own.
    typePhrase(" Clear history ");
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("offers no way to skip the confirmation next time", () => {
    render(
      <TypedConfirmModal
        isOpen
        title="Danger"
        phrase="clear history"
        confirmLabel="Go"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      >
        <p>Body</p>
      </TypedConfirmModal>
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("matchesConfirmationPhrase requires the whole phrase", () => {
    expect(matchesConfirmationPhrase("clear histor", "clear history")).toBe(
      false
    );
    expect(matchesConfirmationPhrase("CLEAR HISTORY", "clear history")).toBe(
      true
    );
  });
});

describe("ClearHistoryModal", () => {
  function renderOpen() {
    return render(
      <ClearHistoryModal isOpen retentionDays={30} onClose={vi.fn()} />
    );
  }

  function answerPreview(
    preview: Parameters<
      ReturnType<typeof useHistoryTrashStore.getState>["receiveClearPreview"]
    >[0]["preview"]
  ) {
    const requestId = useHistoryTrashStore.getState().clearPreview?.requestId;
    expect(requestId).toBeDefined();
    act(() => {
      useHistoryTrashStore
        .getState()
        .receiveClearPreview({ requestId: requestId!, preview });
    });
  }

  it("asks the host what would be cleared and says so before confirming", () => {
    renderOpen();

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.HISTORY_CLEAR_PREVIEW_REQUEST,
      requestId: expect.any(String),
    });
    expect(
      screen.getByRole("button", { name: "Clear history" })
    ).toBeDisabled();

    answerPreview({
      lineageCount: 1326,
      runCount: 1612,
      bytes: 2 * 1024 * 1024 * 1024,
      liveLineages: [
        { workflowKey: "live-key" as WorkflowKey, workflowName: "Reply plan" },
      ],
    });

    expect(
      screen.getByText(/Move 1,326 workflows \(1,612 runs, 2 GB\)/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 running workflow will be kept: Reply plan/)
    ).toBeInTheDocument();
  });

  it("sends the confirmation phrase with the clear request", () => {
    renderOpen();
    answerPreview({
      lineageCount: 2,
      runCount: 3,
      bytes: 10,
      liveLineages: [],
    });

    typePhrase(CLEAR_HISTORY_CONFIRMATION_PHRASE);
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.CLEAR_WORKFLOW_HISTORY,
      confirmation: CLEAR_HISTORY_CONFIRMATION_PHRASE,
    });
  });

  it("cannot be confirmed when there is nothing to clear", () => {
    renderOpen();
    answerPreview({ lineageCount: 0, runCount: 0, bytes: 0, liveLineages: [] });

    typePhrase(CLEAR_HISTORY_CONFIRMATION_PHRASE);

    expect(screen.getByText("There is no history to clear.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Clear history" })
    ).toBeDisabled();
  });

  it("ignores a preview answering an older request", () => {
    renderOpen();
    act(() => {
      useHistoryTrashStore.getState().receiveClearPreview({
        requestId: "stale",
        preview: { lineageCount: 9, runCount: 9, bytes: 9, liveLineages: [] },
      });
    });
    expect(screen.getByText(/Counting this project/)).toBeInTheDocument();
  });
});

describe("RecentlyDeletedModal", () => {
  function setListing(entries: HistoryTrashEntrySummary[]) {
    act(() => {
      useHistoryTrashStore.getState().setListing({
        entries,
        retentionDays: 30,
        totalBytes: entries.reduce((total, item) => total + item.bytes, 0),
      });
    });
  }

  it("requests the list when it opens and shows what each entry holds", () => {
    render(<RecentlyDeletedModal isOpen onClose={vi.fn()} />);
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.HISTORY_TRASH_LIST_REQUEST,
    });

    setListing([
      entry(),
      entry({
        id: "2026-09-30T00-00-00-000Z-aaaa0002",
        kind: HISTORY_TRASH_ENTRY_KINDS.ALL,
        items: ["a", "b", "c", "d"].map((name) => ({
          workflowKey: `${name}-key` as WorkflowKey,
          workflowName: name,
          wholeLineage: true,
          runRefs: [],
          runIds: [],
        })),
      }),
    ]);

    const list = screen.getByRole("list", { name: "Recently deleted items" });
    expect(
      within(list).getByRole("listitem", { name: 'Run 12 of "Fix bug"' })
    ).toBeInTheDocument();
    expect(within(list).getByText("a, b, c, and 1 more")).toBeInTheDocument();
    expect(within(list).getAllByText(/30 days left|29 days left/)).toHaveLength(
      2
    );
  });

  it("restores an entry and disables its buttons while that is in flight", () => {
    render(<RecentlyDeletedModal isOpen onClose={vi.fn()} />);
    setListing([entry()]);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.HISTORY_TRASH_RESTORE,
      entryId: entry().id,
    });
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  });

  it("asks once more before deleting an entry forever", () => {
    render(<RecentlyDeletedModal isOpen onClose={vi.fn()} />);
    setListing([entry()]);

    fireEvent.click(screen.getByRole("button", { name: "Delete forever" }));
    expect(postMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: MESSAGE_TYPES.HISTORY_TRASH_PURGE })
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.HISTORY_TRASH_PURGE,
      entryId: entry().id,
    });
  });

  it("empties only after its own typed confirmation", () => {
    render(<RecentlyDeletedModal isOpen onClose={vi.fn()} />);
    setListing([entry()]);

    fireEvent.click(
      screen.getByRole("button", { name: "Empty Recently deleted" })
    );
    typePhrase(EMPTY_TRASH_CONFIRMATION_PHRASE);
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Empty Recently Deleted" })
      ).getByRole("button", { name: "Delete forever" })
    );

    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.HISTORY_TRASH_EMPTY,
      confirmation: EMPTY_TRASH_CONFIRMATION_PHRASE,
    });
  });

  it("says so when there is nothing to restore", () => {
    render(<RecentlyDeletedModal isOpen onClose={vi.fn()} />);
    setListing([]);
    expect(screen.getByText(/Nothing here/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Empty Recently deleted" })
    ).toBeDisabled();
  });
});

describe("RunHistorySection history management", () => {
  function settings(): FullGlobalSettings {
    return {
      settings: CTRLYOKE_SETTINGS_DEFAULTS,
      sources: {},
      runHistoryPath: "/state/.runs",
      isMultiRoot: false,
    };
  }

  function renderSection(onUpdate = vi.fn()) {
    render(
      <RunHistorySection
        settings={settings()}
        activeScope={SETTING_SCOPES.USER}
        onUpdate={onUpdate}
        onReset={vi.fn()}
        onReload={vi.fn()}
      />
    );
    return onUpdate;
  }

  it("summarizes Recently deleted and opens it", () => {
    renderSection();
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.HISTORY_TRASH_LIST_REQUEST,
    });
    act(() => {
      useHistoryTrashStore.getState().setListing({
        entries: [entry()],
        retentionDays: 30,
        totalBytes: 2048,
      });
    });

    expect(screen.getByText("1 item · 2 KB")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View Recently deleted" })
    );
    expect(
      screen.getByRole("dialog", { name: "Recently Deleted" })
    ).toBeInTheDocument();
  });

  it("opens Clear all history in its own typed-confirmation dialog", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Clear all history" }));

    const dialog = screen.getByRole("dialog", { name: "Clear All History" });
    expect(within(dialog).getByLabelText(/to confirm/i)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Clear history" })
    ).toBeDisabled();
  });

  it("writes the retention period, never below one day", () => {
    const onUpdate = renderSection();
    const input = screen.getByRole("spinbutton", {
      name: /Keep deleted items/,
    });

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    expect(onUpdate).toHaveBeenCalledWith("storage.trashRetentionDays", 1);
  });
});
