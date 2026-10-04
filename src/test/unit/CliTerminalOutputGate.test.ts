import * as assert from "assert";
import { suite, test } from "mocha";
import { CliTerminalOutputGate } from "../../cli/CliTerminalOutputGate";
import { InheritedTerminalOwnership } from "../../utils/InheritedTerminalOwnership";

suite("CliTerminalOutputGate", () => {
  test("renders immediately while no TUI owns the terminal", () => {
    const rendered: string[] = [];
    const gate = new CliTerminalOutputGate(
      new InheritedTerminalOwnership(),
      () => rendered.push("returned")
    );

    gate.write(() => rendered.push("header"));

    assert.deepStrictEqual(rendered, ["header"]);
    gate.dispose();
  });

  // A headless parallel member keeps streaming beside the group's interactive
  // member; writing its output over the TUI would corrupt the TUI's screen.
  test("holds output while a TUI owns the terminal and replays it in order after", () => {
    const ownership = new InheritedTerminalOwnership();
    const rendered: string[] = [];
    const gate = new CliTerminalOutputGate(ownership, (count) =>
      rendered.push(`returned:${count}`)
    );

    const release = ownership.acquire();
    gate.write(() => rendered.push("first"));
    gate.write(() => rendered.push("second"));
    assert.strictEqual(rendered.length, 0);

    release();

    const replayed = [...rendered];
    gate.write(() => rendered.push("after"));
    assert.deepStrictEqual(replayed, ["returned:2", "first", "second"]);
    assert.deepStrictEqual(rendered, [...replayed, "after"]);
    gate.dispose();
  });

  test("still reports the terminal's return when nothing was held", () => {
    const ownership = new InheritedTerminalOwnership();
    const counts: number[] = [];
    const gate = new CliTerminalOutputGate(ownership, (count) =>
      counts.push(count)
    );

    ownership.acquire()();

    assert.deepStrictEqual(counts, [0]);
    gate.dispose();
  });
});

suite("InheritedTerminalOwnership", () => {
  test("stays owned until the last owner releases, and each release counts once", () => {
    const ownership = new InheritedTerminalOwnership();
    const changes: boolean[] = [];
    const subscription = ownership.onDidChange((owned) => changes.push(owned));

    const releaseFirst = ownership.acquire();
    const releaseSecond = ownership.acquire();
    releaseFirst();
    releaseFirst();
    assert.strictEqual(ownership.isOwned(), true);

    releaseSecond();

    assert.strictEqual(ownership.isOwned(), false);
    assert.deepStrictEqual(changes, [true, false]);
    subscription.dispose();
  });
});
