import * as assert from "assert";
import { suite, test } from "mocha";
import { isTerminalAutoResponse } from "../../utils/TerminalAutoResponse";

suite("isTerminalAutoResponse", () => {
  test("recognizes xterm's replies to TUI queries and focus reports", () => {
    for (const reply of [
      "\x1b[12;40R", // cursor position report
      "\x1b[0n", // device status
      "\x1b[?62;22c", // primary device attributes
      "\x1b[>0;276;0c", // secondary device attributes
      "\x1b[8;24;80t", // window size report
      "\x1b[?2004;1$y", // DECRPM
      "\x1b[?1u", // kitty keyboard flags
      "\x1b[I", // focus in
      "\x1b[O", // focus out
      "\x1b]11;rgb:1e1e/1e1e/1e1e\x07", // OSC color reply, BEL-terminated
      "\x1b]10;rgb:cccc/cccc/cccc\x1b\\", // OSC color reply, ST-terminated
      "\x1bP>|xterm.js(6.0.0)\x1b\\", // XTVERSION
      "\x1b[12;40R\x1b[?62;22c", // batched replies
    ]) {
      assert.strictEqual(
        isTerminalAutoResponse(reply),
        true,
        JSON.stringify(reply)
      );
    }
  });

  test("treats keystrokes, pastes and mouse reports as real input", () => {
    for (const input of [
      "a",
      "\r",
      "\x03", // Ctrl+C
      "\x1b", // Escape
      "\x1b[A", // arrow up
      "\x1b[200~pasted\x1b[201~",
      "\x1b[<0;10;5M", // SGR mouse press
      "\x1b[Ix", // focus report followed by a keystroke
      "",
    ]) {
      assert.strictEqual(
        isTerminalAutoResponse(input),
        false,
        JSON.stringify(input)
      );
    }
  });
});
