import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalControlBarEditor } from "@components/settings/TerminalControlBarEditor";
import { SETTING_SCOPES } from "@/types/messages";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type { FullGlobalSettings } from "@root/types/WebviewMessageTypes";
import type {
  TerminalMobileBarLayout,
  TerminalShortcut,
} from "@root/types/CtrlYokeSettings";
import {
  DEFAULT_TERMINAL_BAR_LAYOUT,
  TERMINAL_BAR_CTRL_ID,
  TERMINAL_BAR_ITEM_REGISTRY,
  TERMINAL_BAR_KEY_IDS,
  TERMINAL_BAR_SHORTCUT_IDS,
} from "@root/utils/TerminalControlBarFormat";

const BAR_LAYOUT_PATH = "terminal.mobileBarLayout";
const CUSTOM_SHORTCUTS_PATH = "terminal.mobileCustomShortcuts";
const BUILT_IN_IDS = [
  ...Object.keys(TERMINAL_BAR_ITEM_REGISTRY),
  TERMINAL_BAR_CTRL_ID,
];

function completeLayout(
  bar: string[],
  popup: string[],
  customIds: string[] = []
): TerminalMobileBarLayout {
  const placed = new Set([...bar, ...popup]);
  return {
    bar,
    popup,
    hidden: [...BUILT_IN_IDS, ...customIds].filter((id) => !placed.has(id)),
  };
}

function createSettings(
  mobileBarLayout: TerminalMobileBarLayout,
  mobileCustomShortcuts: TerminalShortcut[] = []
): FullGlobalSettings {
  return {
    settings: {
      ...CTRLYOKE_SETTINGS_DEFAULTS,
      terminal: {
        ...CTRLYOKE_SETTINGS_DEFAULTS.terminal,
        mobileBarLayout,
        mobileCustomShortcuts,
      },
    },
    sources: {},
    isMultiRoot: false,
  };
}

function renderEditor(
  mobileBarLayout: TerminalMobileBarLayout,
  mobileCustomShortcuts: TerminalShortcut[] = []
) {
  const onUpdate = vi.fn<(path: string, value: unknown) => void>();
  render(
    <TerminalControlBarEditor
      settings={createSettings(mobileBarLayout, mobileCustomShortcuts)}
      activeScope={SETTING_SCOPES.USER}
      onUpdate={onUpdate}
      onReset={vi.fn()}
    />
  );
  return onUpdate;
}

function rect(top: number, left = 0): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + 200,
    bottom: top + 20,
    width: 200,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect;
}

async function keyboardReorder(
  handle: HTMLElement,
  rows: HTMLElement[],
  direction: "ArrowDown" | "ArrowRight"
) {
  rows.forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
      direction === "ArrowRight" ? rect(0, index * 220) : rect(index * 40)
    );
  });
  handle.focus();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  expect(handle).toHaveAttribute("aria-pressed", "true");
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.keyDown(document, { code: direction, key: direction });
  fireEvent.keyDown(document, { code: "Space", key: " " });
}

function layoutUpdates(onUpdate: ReturnType<typeof vi.fn>) {
  return onUpdate.mock.calls
    .filter(([path]) => path === BAR_LAYOUT_PATH)
    .map(([, value]) => value as TerminalMobileBarLayout);
}

function lastLayout(onUpdate: ReturnType<typeof vi.fn>) {
  const updates = layoutUpdates(onUpdate);
  return updates[updates.length - 1];
}

describe("TerminalControlBarEditor", () => {
  afterEach(() => {
    cleanup();
  });

  it("reorders items within the bar with the horizontal keyboard drag sensor", async () => {
    const onUpdate = renderEditor(
      completeLayout(
        [
          TERMINAL_BAR_CTRL_ID,
          TERMINAL_BAR_KEY_IDS.ESC,
          TERMINAL_BAR_KEY_IDS.TAB,
        ],
        []
      )
    );
    const handles = screen.getAllByRole("button", {
      name: /Drag to reorder (Ctrl|Esc|Tab)/,
    });
    await keyboardReorder(
      handles[0],
      handles.map((handle) => handle.parentElement as HTMLElement),
      "ArrowRight"
    );

    expect(lastLayout(onUpdate)?.bar).toEqual([
      TERMINAL_BAR_KEY_IDS.ESC,
      TERMINAL_BAR_CTRL_ID,
      TERMINAL_BAR_KEY_IDS.TAB,
    ]);
  });

  it("reorders items within the popup list with the vertical keyboard drag sensor", async () => {
    const onUpdate = renderEditor(
      completeLayout(
        [...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
        [TERMINAL_BAR_SHORTCUT_IDS.CTRL_C, TERMINAL_BAR_SHORTCUT_IDS.CTRL_Z]
      )
    );
    const handles = screen.getAllByRole("button", {
      name: /Drag to reorder Ctrl\+[CZ]/,
    });
    await keyboardReorder(
      handles[0],
      handles.map((handle) => handle.parentElement as HTMLElement),
      "ArrowDown"
    );

    expect(lastLayout(onUpdate)?.popup).toEqual([
      TERMINAL_BAR_SHORTCUT_IDS.CTRL_Z,
      TERMINAL_BAR_SHORTCUT_IDS.CTRL_C,
    ]);
  });

  it("promotes a popup item to the end of the bar", async () => {
    const user = userEvent.setup();
    const onUpdate = renderEditor(
      completeLayout(
        [...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
        [TERMINAL_BAR_SHORTCUT_IDS.CTRL_C]
      )
    );

    await user.click(
      screen.getByRole("button", { name: "Move Ctrl+C to control bar" })
    );

    expect(lastLayout(onUpdate)).toEqual(
      expect.objectContaining({
        bar: [
          ...DEFAULT_TERMINAL_BAR_LAYOUT.bar,
          TERMINAL_BAR_SHORTCUT_IDS.CTRL_C,
        ],
        popup: [],
      })
    );
  });

  it("demotes a non-Ctrl bar item to popup and hides Ctrl directly", async () => {
    const user = userEvent.setup();
    const onUpdate = renderEditor(
      completeLayout([TERMINAL_BAR_CTRL_ID, TERMINAL_BAR_KEY_IDS.ESC], [])
    );

    await user.click(
      screen.getByRole("button", { name: "Move Esc to shortcut list" })
    );
    expect(lastLayout(onUpdate)).toEqual(
      expect.objectContaining({
        bar: [TERMINAL_BAR_CTRL_ID],
        popup: expect.arrayContaining([TERMINAL_BAR_KEY_IDS.ESC]),
      })
    );

    await user.click(
      screen.getByRole("button", { name: "Hide Ctrl modifier" })
    );
    expect(lastLayout(onUpdate)).toEqual(
      expect.objectContaining({
        bar: [],
        popup: expect.arrayContaining([TERMINAL_BAR_KEY_IDS.ESC]),
        hidden: expect.arrayContaining([TERMINAL_BAR_CTRL_ID]),
      })
    );
  });

  it("restores non-Ctrl items to popup and Ctrl to the end of the bar", async () => {
    const user = userEvent.setup();
    const onUpdate = renderEditor({
      ...completeLayout([], []),
      hidden: [TERMINAL_BAR_KEY_IDS.ESC, TERMINAL_BAR_CTRL_ID],
    });

    await user.click(screen.getByRole("button", { name: "Restore Esc" }));
    expect(lastLayout(onUpdate)).toEqual(
      expect.objectContaining({
        bar: [],
        popup: expect.arrayContaining([TERMINAL_BAR_KEY_IDS.ESC]),
      })
    );

    await user.click(
      screen.getByRole("button", { name: "Restore Ctrl to the control bar" })
    );
    expect(lastLayout(onUpdate)).toEqual(
      expect.objectContaining({
        bar: [TERMINAL_BAR_CTRL_ID],
        popup: expect.arrayContaining([TERMINAL_BAR_KEY_IDS.ESC]),
        hidden: [],
      })
    );
  });

  it.each(["bar", "popup", "hidden"] as const)(
    "permanently deletes a custom shortcut that started in the %s",
    async (location) => {
      const user = userEvent.setup();
      const customId = `custom-${location}`;
      const shortcut = {
        id: customId,
        label: `Custom ${location}`,
        sequence: "\\x1b[1~",
      };
      const layout = completeLayout(
        location === "bar"
          ? [TERMINAL_BAR_CTRL_ID, customId]
          : [TERMINAL_BAR_CTRL_ID],
        location === "popup" ? [customId] : [],
        location === "hidden" ? [customId] : []
      );
      const onUpdate = renderEditor(layout, [shortcut]);

      if (location === "bar") {
        await user.click(
          screen.getByRole("button", {
            name: "Move Custom bar to shortcut list",
          })
        );
      } else if (location === "hidden") {
        await user.click(
          screen.getByRole("button", { name: "Restore Custom hidden" })
        );
      }
      await user.click(
        screen.getByRole("button", {
          name: `Delete Custom ${location}`,
        })
      );

      expect(onUpdate).toHaveBeenCalledWith(CUSTOM_SHORTCUTS_PATH, []);
      const finalLayout = lastLayout(onUpdate);
      expect(finalLayout?.bar).not.toContain(customId);
      expect(finalLayout?.popup).not.toContain(customId);
      expect(finalLayout?.hidden).not.toContain(customId);
    }
  );

  it("resets built-in placement to default while preserving custom shortcuts in popup", async () => {
    const user = userEvent.setup();
    const customShortcut = {
      id: "custom-preserved",
      label: "Preserved",
      sequence: "\\x1b[1~",
    };
    const onUpdate = renderEditor(
      completeLayout(
        [TERMINAL_BAR_KEY_IDS.ENTER],
        [TERMINAL_BAR_SHORTCUT_IDS.CTRL_C],
        [customShortcut.id]
      ),
      [customShortcut]
    );

    await user.click(screen.getByRole("button", { name: "Reset to default" }));

    expect(lastLayout(onUpdate)).toEqual({
      bar: [...DEFAULT_TERMINAL_BAR_LAYOUT.bar],
      popup: [...DEFAULT_TERMINAL_BAR_LAYOUT.popup, customShortcut.id],
      hidden: [...DEFAULT_TERMINAL_BAR_LAYOUT.hidden],
    });
  });

  it("never offers Ctrl a move-to-popup control", () => {
    renderEditor(completeLayout([TERMINAL_BAR_CTRL_ID], []));

    expect(
      screen.queryByRole("button", {
        name: "Move Ctrl to shortcut list",
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Ctrl.*shortcut list/i,
      })
    ).not.toBeInTheDocument();
  });
});
