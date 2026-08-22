import { strict as assert } from "node:assert";
import { suite, test } from "mocha";
import {
  DEFAULT_TERMINAL_BAR_LAYOUT,
  TERMINAL_BAR_CTRL_ID,
  TERMINAL_BAR_KEY_IDS,
  TERMINAL_BAR_SHORTCUT_IDS,
  reconcileTerminalBarLayout,
} from "../../utils/TerminalControlBarFormat";

suite("TerminalControlBarFormat", () => {
  test("drops unknown ids and reconciles known ids absent from every list", () => {
    const layout = reconcileTerminalBarLayout(
      {
        bar: [TERMINAL_BAR_KEY_IDS.ESC, "unknown-bar"],
        popup: [TERMINAL_BAR_SHORTCUT_IDS.CTRL_C, "unknown-popup"],
        hidden: ["unknown-hidden"],
      },
      ["custom-shortcut"]
    );

    assert.deepEqual(layout.bar, [
      TERMINAL_BAR_CTRL_ID,
      TERMINAL_BAR_KEY_IDS.ESC,
    ]);
    assert.ok(layout.popup.includes("custom-shortcut"));
    assert.ok(layout.popup.includes(TERMINAL_BAR_KEY_IDS.TAB));
    assert.ok(!layout.bar.includes("unknown-bar"));
    assert.ok(!layout.popup.includes("unknown-popup"));
    assert.ok(!layout.hidden.includes("unknown-hidden"));
  });

  test("moves Ctrl found in popup to the bar", () => {
    const layout = reconcileTerminalBarLayout(
      {
        bar: [TERMINAL_BAR_KEY_IDS.ESC],
        popup: [TERMINAL_BAR_CTRL_ID, TERMINAL_BAR_SHORTCUT_IDS.CTRL_C],
        hidden: [],
      },
      []
    );

    assert.deepEqual(layout.bar.slice(0, 2), [
      TERMINAL_BAR_KEY_IDS.ESC,
      TERMINAL_BAR_CTRL_ID,
    ]);
    assert.ok(!layout.popup.includes(TERMINAL_BAR_CTRL_ID));
  });

  test("inserts Ctrl at the front of the bar when absent from bar and hidden", () => {
    const layout = reconcileTerminalBarLayout(
      {
        bar: [TERMINAL_BAR_KEY_IDS.ESC],
        popup: [TERMINAL_BAR_SHORTCUT_IDS.CTRL_C],
        hidden: [],
      },
      []
    );

    assert.equal(layout.bar[0], TERMINAL_BAR_CTRL_ID);
    assert.deepEqual(DEFAULT_TERMINAL_BAR_LAYOUT.bar.slice(0, 1), [
      TERMINAL_BAR_CTRL_ID,
    ]);
  });
});
