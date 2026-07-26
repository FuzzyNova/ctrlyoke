import * as assert from "assert";
import { suite, test } from "mocha";
import { BackgroundFollowUpState } from "../../core/harness/shared/BackgroundFollowUpState";

suite("BackgroundFollowUpState", () => {
  test("tracks overlapping launches and removes only matching notifications", () => {
    const state = new BackgroundFollowUpState();

    state.launch("task-1");
    state.launch("task-2");
    state.launch("task-1");
    assert.strictEqual(state.isCompletionBlocked(), true);

    assert.strictEqual(state.consumeNotification("unknown"), false);
    assert.strictEqual(state.isCompletionBlocked(), true);
    assert.strictEqual(state.consumeNotification("task-1"), true);
    assert.strictEqual(state.consumeNotification("task-1"), false);
    assert.strictEqual(state.isCompletionBlocked(), true);
    assert.strictEqual(state.consumeNotification("task-2"), true);
    assert.strictEqual(state.isResumedTurnPending(), true);
  });

  test("keeps the resumed-turn latch set through several notifications and new launches", () => {
    const state = new BackgroundFollowUpState();

    state.launch("task-1");
    state.consumeNotification("task-1");
    state.launch("task-2");
    state.launch("task-3");
    state.consumeNotification("task-2");
    state.consumeNotification("task-3");

    assert.strictEqual(state.isResumedTurnPending(), true);
    assert.strictEqual(state.isCompletionBlocked(), true);
    state.resumedTurnClosed();
    assert.strictEqual(state.isResumedTurnPending(), false);
    assert.strictEqual(state.isCompletionBlocked(), false);
  });

  test("does not clear the latch on unmatched or duplicate notifications", () => {
    const state = new BackgroundFollowUpState();

    state.launch("task-1");
    assert.strictEqual(state.consumeNotification("task-2"), false);
    assert.strictEqual(state.isResumedTurnPending(), false);
    assert.strictEqual(state.consumeNotification("task-1"), true);
    assert.strictEqual(state.consumeNotification("task-1"), false);
    state.resumedTurnClosed();
    assert.strictEqual(state.isCompletionBlocked(), false);
  });

  test("keeps zero-pending state blocked until the resumed turn closes", () => {
    const state = new BackgroundFollowUpState();

    state.launch("task-1");
    state.consumeNotification("task-1");
    assert.strictEqual(state.isCompletionBlocked(), true);
    assert.strictEqual(state.isResumedTurnPending(), true);

    state.resumedTurnClosed();
    assert.strictEqual(state.isCompletionBlocked(), false);
  });

  test("removes failed launches without creating a resumed-turn latch", () => {
    const state = new BackgroundFollowUpState();

    state.launch("task-1");
    assert.strictEqual(state.remove("task-1"), true);
    assert.strictEqual(state.remove("task-1"), false);
    assert.strictEqual(state.isResumedTurnPending(), false);
    assert.strictEqual(state.isCompletionBlocked(), false);
  });

  test("resets pending IDs, latch, and stale-stop checks", () => {
    const state = new BackgroundFollowUpState({ staleStopGuardChecks: 2 });

    state.launch("task-1");
    state.consumeNotification("task-1");
    state.resumedTurnClosed();
    state.reset();

    assert.strictEqual(state.isResumedTurnPending(), false);
    assert.strictEqual(state.isCompletionBlocked(), false);
  });

  test("optionally guards the two checks raced by a stale Stop", () => {
    const state = new BackgroundFollowUpState({ staleStopGuardChecks: 2 });

    state.launch("task-1");
    state.consumeNotification("task-1");
    state.resumedTurnClosed();
    assert.strictEqual(state.isCompletionBlocked(), true);
    assert.strictEqual(state.isCompletionBlocked(), true);
    assert.strictEqual(state.isCompletionBlocked(), false);
  });
});
