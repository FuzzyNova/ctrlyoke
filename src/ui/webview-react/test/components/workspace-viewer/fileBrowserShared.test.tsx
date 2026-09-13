import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_ENTRY_KINDS } from "@root/types/DashboardConstants";
import {
  DEFAULT_WORKSPACE_ENTRY_SORT,
  WORKSPACE_ENTRY_SORT_DIRECTIONS,
  WORKSPACE_ENTRY_SORT_KEYS,
  type WorkspaceEntry,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  EntryRow,
  FILE_BROWSER_GRID_TEMPLATE,
  FileBrowserSortHeader,
  formatWorkspaceEntryModifiedAt,
} from "@components/workspace-viewer/fileBrowserShared";

function makeEntry(overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    name: "index.ts",
    path: "src/index.ts",
    kind: WORKSPACE_ENTRY_KINDS.FILE,
    modifiedAt: Date.UTC(2026, 7, 22, 16, 42),
    ...overrides,
  };
}

describe("formatWorkspaceEntryModifiedAt", () => {
  it("returns locale-formatted visible and full values for a valid timestamp", () => {
    const formatted = formatWorkspaceEntryModifiedAt(
      Date.UTC(2026, 7, 22, 16, 42)
    );

    expect(formatted.compact).not.toBe("—");
    expect(formatted.full).not.toBe("—");
    expect(formatted.compact).toMatch(/2026|8|22|4|16|42/);
    expect(formatted.full).toMatch(/2026|8|22|4|16|42/);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -Infinity])(
    "uses an em dash for missing or invalid metadata (%s)",
    (modifiedAt) => {
      expect(formatWorkspaceEntryModifiedAt(modifiedAt)).toEqual({
        compact: "—",
        full: "—",
      });
    }
  );
});

describe("FileBrowserSortHeader", () => {
  it("reports every requested key and exposes the active direction accessibly", () => {
    const onSortKeyRequest = vi.fn();
    render(
      <FileBrowserSortHeader
        sort={DEFAULT_WORKSPACE_ENTRY_SORT}
        onSortKeyRequest={onSortKeyRequest}
      />
    );

    const header = screen.getByTestId("file-browser-sort-header");
    const nameButton = within(header).getByRole("button", {
      name: /Name, currently ascending/i,
    });
    const dateButton = within(header).getByRole("button", {
      name: /Date modified, inactive.*descending/i,
    });

    expect(nameButton).toHaveClass("col-span-2", "pl-[1.625rem]");
    expect(dateButton).toHaveClass("col-start-3", "justify-center");
    expect(nameButton).toHaveAttribute("aria-pressed", "true");
    expect(dateButton).toHaveAttribute("aria-pressed", "false");
    expect(header.querySelectorAll(".codicon-chevron-up")).toHaveLength(1);
    expect(header.querySelectorAll(".codicon-chevron-down")).toHaveLength(0);

    fireEvent.click(nameButton);
    fireEvent.click(dateButton);
    expect(onSortKeyRequest.mock.calls).toEqual([
      [WORKSPACE_ENTRY_SORT_KEYS.NAME],
      [WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT],
    ]);
  });

  it("shows the descending active state and only one decorative chevron", () => {
    render(
      <FileBrowserSortHeader
        sort={{
          key: WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT,
          direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.DESCENDING,
        }}
        onSortKeyRequest={vi.fn()}
      />
    );

    const header = screen.getByTestId("file-browser-sort-header");
    expect(
      within(header).getByRole("button", {
        name: /Date modified, currently descending/i,
      })
    ).toHaveAttribute("aria-pressed", "true");
    expect(header.querySelectorAll(".codicon-chevron-down")).toHaveLength(1);
    expect(header.querySelectorAll(".codicon-chevron-up")).toHaveLength(0);
  });
});

describe("EntryRow", () => {
  it("shares the header tracks and exposes path, full time, and directory presentation", () => {
    const entry = makeEntry({
      name: "src",
      path: "src",
      kind: WORKSPACE_ENTRY_KINDS.DIRECTORY,
    });
    render(
      <>
        <FileBrowserSortHeader
          sort={DEFAULT_WORKSPACE_ENTRY_SORT}
          onSortKeyRequest={vi.fn()}
        />
        <EntryRow
          entry={entry}
          isSelected={false}
          statusColorClass="text-warning-fg"
          onClick={vi.fn()}
        />
      </>
    );

    const header = screen.getByTestId("file-browser-sort-header");
    const row = screen.getByRole("button", {
      name: /src\/, src, modified/i,
    });
    const modifiedAt = formatWorkspaceEntryModifiedAt(entry.modifiedAt);

    expect(header).toHaveStyle({
      gridTemplateColumns: FILE_BROWSER_GRID_TEMPLATE,
    });
    expect(row).toHaveStyle({
      gridTemplateColumns: FILE_BROWSER_GRID_TEMPLATE,
    });
    expect(row).toHaveAttribute("title", `src — Modified ${modifiedAt.full}`);
    expect(row).toHaveTextContent("src/");
    expect(row).toHaveTextContent(modifiedAt.compact);
    expect(row.querySelector(".text-warning-fg")).toBeInTheDocument();
  });

  it("preserves selected, cut, disabled, context-menu, and native button behavior", () => {
    const onClick = vi.fn();
    const openContextMenu = vi.fn();
    const { rerender } = render(
      <EntryRow
        entry={makeEntry()}
        isSelected
        isCut
        statusColorClass={undefined}
        onClick={onClick}
        openContextMenu={openContextMenu}
      />
    );

    const selectedRow = screen.getByRole("button", { name: /index\.ts/ });
    expect(selectedRow).toHaveClass("cy-list-row-selected");
    expect(selectedRow).toHaveStyle({ opacity: 0.5 });
    expect(selectedRow).toHaveClass("min-h-[44px]");
    fireEvent.click(selectedRow);
    fireEvent.contextMenu(selectedRow, { clientX: 12, clientY: 34 });
    expect(onClick).toHaveBeenCalledOnce();
    expect(openContextMenu).toHaveBeenCalledWith(
      12,
      34,
      expect.objectContaining({ path: "src/index.ts" })
    );

    rerender(
      <EntryRow
        entry={makeEntry()}
        isSelected={false}
        disabled
        statusColorClass={undefined}
        onClick={onClick}
        openContextMenu={openContextMenu}
      />
    );
    const disabledRow = screen.getByRole("button", { name: /index\.ts/ });
    expect(disabledRow).toBeDisabled();
    expect(disabledRow).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(disabledRow);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
