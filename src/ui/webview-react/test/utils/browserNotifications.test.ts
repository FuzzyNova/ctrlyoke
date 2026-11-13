import { beforeEach, describe, expect, it, vi } from "vitest";

const subscription = {
  toJSON: () => ({ endpoint: "https://push.example/sub", keys: {} }),
};
const getSubscription = vi.fn();

describe("claimPushSubscriptionIfUnowned", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    window.__ctrlyokeStandalone = true;
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("fetch", vi.fn());
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription },
        }),
      },
    });
    getSubscription.mockReset().mockResolvedValue(subscription);
  });

  it("registers an existing subscription missing from the server list", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ subscriptions: [] }))
      .mockResolvedValueOnce(Response.json({ id: "claimed-id" }));
    localStorage.setItem("ctrlyoke-push-subscription-id", "legacy-id");

    const { claimPushSubscriptionIfUnowned } =
      await import("@utils/browserNotifications");
    await claimPushSubscriptionIfUnowned();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/notifications/subscriptions",
      expect.objectContaining({ method: "POST" })
    );
    expect(localStorage.getItem("ctrlyoke-push-subscription-id")).toBe(
      "claimed-id"
    );
  });

  it("does not register a subscription already listed by the server", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ subscriptions: [{ id: "saved-id" }] })
    );
    localStorage.setItem("ctrlyoke-push-subscription-id", "saved-id");

    const { claimPushSubscriptionIfUnowned } =
      await import("@utils/browserNotifications");
    await claimPushSubscriptionIfUnowned();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside standalone mode", async () => {
    window.__ctrlyokeStandalone = false;
    const { claimPushSubscriptionIfUnowned } =
      await import("@utils/browserNotifications");
    await claimPushSubscriptionIfUnowned();
    expect(fetch).not.toHaveBeenCalled();
    expect(getSubscription).not.toHaveBeenCalled();
  });
});
