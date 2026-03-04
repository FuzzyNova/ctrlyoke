import * as assert from "assert";
import { suite, test } from "mocha";
import { TypedEmitter } from "../../utils/TypedEmitter";

suite("TypedEmitter", () => {
  suite("fire / event", () => {
    test("fire() invokes a subscribed listener", () => {
      const emitter = new TypedEmitter<void>();
      let called = false;
      emitter.event(() => {
        called = true;
      });
      emitter.fire(undefined as unknown as void);
      assert.strictEqual(called, true);
    });

    test("fire(data) delivers exact data to listener", () => {
      const emitter = new TypedEmitter<string>();
      let received: string | undefined;
      emitter.event((val) => {
        received = val;
      });
      emitter.fire("hello");
      assert.strictEqual(received, "hello");
    });

    test("fire(data) with object payload delivers same reference", () => {
      const emitter = new TypedEmitter<{ count: number }>();
      const payload = { count: 42 };
      let received: { count: number } | undefined;
      emitter.event((val) => {
        received = val;
      });
      emitter.fire(payload);
      assert.strictEqual(received, payload);
    });

    test("multiple fire() calls invoke listener each time", () => {
      const emitter = new TypedEmitter<number>();
      const received: number[] = [];
      emitter.event((val) => received.push(val));
      emitter.fire(1);
      emitter.fire(2);
      emitter.fire(3);
      assert.deepStrictEqual(received, [1, 2, 3]);
    });

    test("multiple listeners for same emitter are all invoked", () => {
      const emitter = new TypedEmitter<string>();
      const calls: string[] = [];
      emitter.event((v) => calls.push(`a:${v}`));
      emitter.event((v) => calls.push(`b:${v}`));
      emitter.fire("x");
      assert.deepStrictEqual(calls.sort(), ["a:x", "b:x"]);
    });

    test("listener not invoked before first fire", () => {
      const emitter = new TypedEmitter<number>();
      let called = false;
      emitter.event(() => {
        called = true;
      });
      assert.strictEqual(called, false);
    });
  });

  suite("dispose (subscription)", () => {
    test("dispose() on subscription prevents further invocations", () => {
      const emitter = new TypedEmitter<number>();
      let count = 0;
      const sub = emitter.event(() => count++);
      emitter.fire(1);
      sub.dispose();
      emitter.fire(2);
      assert.strictEqual(
        count,
        1,
        "listener should only be called once before dispose"
      );
    });

    test("other listeners unaffected when one subscription is disposed", () => {
      const emitter = new TypedEmitter<number>();
      let aCount = 0;
      let bCount = 0;
      const subA = emitter.event(() => aCount++);
      emitter.event(() => bCount++);
      emitter.fire(1);
      subA.dispose();
      emitter.fire(2);
      assert.strictEqual(aCount, 1, "A should only fire once");
      assert.strictEqual(bCount, 2, "B should fire twice");
    });

    test("calling dispose() twice does not throw", () => {
      const emitter = new TypedEmitter<void>();
      const sub = emitter.event(() => {
        /* no-op */
      });
      sub.dispose();
      assert.doesNotThrow(() => sub.dispose());
    });
  });

  suite("dispose (emitter)", () => {
    test("emitter.dispose() removes all listeners — subsequent fire is ignored", () => {
      const emitter = new TypedEmitter<number>();
      let count = 0;
      emitter.event(() => count++);
      emitter.event(() => count++);
      emitter.fire(1);
      emitter.dispose();
      emitter.fire(2);
      assert.strictEqual(
        count,
        2,
        "only the two listeners before dispose should fire"
      );
    });

    test("new listener subscribed after emitter.dispose() still works after re-subscribe", () => {
      // After dispose() removes all listeners, new subscriptions can still be added and fired
      const emitter = new TypedEmitter<string>();
      emitter.dispose();
      let received: string | undefined;
      emitter.event((v) => {
        received = v;
      });
      emitter.fire("post-dispose");
      assert.strictEqual(received, "post-dispose");
    });
  });
});
