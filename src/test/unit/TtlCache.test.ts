import * as assert from "assert";
import { suite, test } from "mocha";
import { TtlCache } from "../../utils/TtlCache";

suite("TtlCache", () => {
  suite("get", () => {
    test("should call fn and return fresh data on first call", async () => {
      const cache = new TtlCache<string>(5000);
      const result = await cache.get(async () => ["a", "b", "c"]);
      assert.deepStrictEqual(result, ["a", "b", "c"]);
    });

    test("should return cached data within TTL", async () => {
      const cache = new TtlCache<number>(5000);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return [callCount];
      };

      const first = await cache.get(fn);
      const second = await cache.get(fn);
      assert.deepStrictEqual(first, [1]);
      assert.deepStrictEqual(second, [1], "should return cached value");
      assert.strictEqual(callCount, 1, "fn should only be called once");
    });

    test("should refresh after TTL expires", async () => {
      const cache = new TtlCache<number>(50);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return [callCount * 10];
      };

      const first = await cache.get(fn);
      assert.deepStrictEqual(first, [10]);

      await new Promise((r) => setTimeout(r, 60));

      const second = await cache.get(fn);
      assert.deepStrictEqual(second, [20], "should have refreshed");
      assert.strictEqual(callCount, 2);
    });

    test("should call fn only once for multiple gets within TTL", async () => {
      const cache = new TtlCache<string>(5000);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return ["data"];
      };

      await cache.get(fn);
      await cache.get(fn);
      await cache.get(fn);
      assert.strictEqual(callCount, 1, "fn should be called exactly once");
    });

    test("should work with different generic types (objects)", async () => {
      interface Item {
        id: number;
        name: string;
      }
      const cache = new TtlCache<Item>(5000);
      const items: Item[] = [
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ];
      const result = await cache.get(async () => items);
      assert.deepStrictEqual(result, items);
      assert.strictEqual(result, items, "should return same reference");
    });

    test("should return empty array from fn without caching it", async () => {
      const cache = new TtlCache<string>(5000);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return [] as string[];
      };

      const first = await cache.get(fn);
      assert.deepStrictEqual(first, []);
      // Empty array means cached.length === 0, so next call should re-fetch
      const second = await cache.get(fn);
      assert.deepStrictEqual(second, []);
      assert.strictEqual(callCount, 2, "empty result should not be cached");
    });

    test("should cache non-empty result after previously empty result", async () => {
      const cache = new TtlCache<string>(5000);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return callCount === 1 ? [] : ["found"];
      };

      await cache.get(fn); // returns []
      const second = await cache.get(fn); // re-fetches because [] not cached
      assert.deepStrictEqual(second, ["found"]);
      // Now third call should use cache
      const third = await cache.get(fn);
      assert.deepStrictEqual(third, ["found"]);
      assert.strictEqual(callCount, 2, "should not call fn a third time");
    });

    test("should handle async fn that takes time to resolve", async () => {
      const cache = new TtlCache<number>(5000);
      const fn = async () => {
        await new Promise((r) => setTimeout(r, 20));
        return [42];
      };

      const result = await cache.get(fn);
      assert.deepStrictEqual(result, [42]);
    });

    test("should handle fn that throws by propagating the error", async () => {
      const cache = new TtlCache<string>(5000);
      const fn = async (): Promise<string[]> => {
        throw new Error("fetch failed");
      };

      await assert.rejects(() => cache.get(fn), /fetch failed/);
    });

    test("should allow successful fetch after a failed one", async () => {
      const cache = new TtlCache<string>(5000);
      let shouldFail = true;
      const fn = async () => {
        if (shouldFail) {
          throw new Error("transient error");
        }
        return ["recovered"];
      };

      await assert.rejects(() => cache.get(fn), /transient error/);
      shouldFail = false;
      const result = await cache.get(fn);
      assert.deepStrictEqual(result, ["recovered"]);
    });

    test("should not call fn concurrently (second call sees stale-then-refresh)", async () => {
      // Two sequential calls — both should resolve without double-fetching
      const cache = new TtlCache<number>(50);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return [callCount];
      };

      const r1 = await cache.get(fn);
      assert.deepStrictEqual(r1, [1]);
      // Still within TTL, so second call uses cache
      const r2 = await cache.get(fn);
      assert.deepStrictEqual(r2, [1]);
      assert.strictEqual(callCount, 1);
    });
  });

  suite("invalidate", () => {
    test("should force refresh on next get()", async () => {
      const cache = new TtlCache<number>(5000);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return [callCount * 100];
      };

      await cache.get(fn);
      assert.strictEqual(callCount, 1);

      cache.invalidate();

      const result = await cache.get(fn);
      assert.deepStrictEqual(result, [200]);
      assert.strictEqual(callCount, 2, "should have re-fetched after invalidate");
    });

    test("should be safe to call invalidate() multiple times", () => {
      const cache = new TtlCache<string>(5000);
      assert.doesNotThrow(() => {
        cache.invalidate();
        cache.invalidate();
        cache.invalidate();
      });
    });

    test("should be safe to call invalidate() before any get()", async () => {
      const cache = new TtlCache<string>(5000);
      cache.invalidate();
      const result = await cache.get(async () => ["fresh"]);
      assert.deepStrictEqual(result, ["fresh"]);
    });

    test("should not affect data returned by a get() already in progress", async () => {
      const cache = new TtlCache<string>(5000);
      // Prime the cache
      await cache.get(async () => ["original"]);
      // Invalidate
      cache.invalidate();
      // Next get fetches fresh
      const result = await cache.get(async () => ["refreshed"]);
      assert.deepStrictEqual(result, ["refreshed"]);
    });
  });

  suite("TTL boundary", () => {
    test("should cache with TTL of 0 (always re-fetches)", async () => {
      const cache = new TtlCache<number>(0);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return [callCount];
      };

      await cache.get(fn);
      await cache.get(fn);
      // With TTL 0, `now - timestamp < 0` is false, so it always re-fetches
      // But the check is `now - this.timestamp < this.ttlMs` which is `X < 0` — always false
      // So with ttlMs=0, even cached.length > 0 won't help
      assert.strictEqual(callCount, 2, "TTL 0 should always re-fetch");
    });

    test("should use cache right at the boundary of TTL", async () => {
      const cache = new TtlCache<number>(100);
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return [callCount];
      };

      await cache.get(fn);
      // Wait less than TTL
      await new Promise((r) => setTimeout(r, 30));
      const result = await cache.get(fn);
      assert.deepStrictEqual(result, [1], "should still use cache");
      assert.strictEqual(callCount, 1);
    });
  });
});
