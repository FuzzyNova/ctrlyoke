import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import {
  COMPLETION_NOTIFICATION_KINDS,
  COMPLETION_NOTIFICATION_SEVERITY,
} from "../../types/DashboardConstants";
import {
  WebPushService,
  type WebPushSubscriptionPayload,
} from "../../server/WebPushService";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";
import { ctrlyokeStateHome } from "../../utils/ProjectStatePaths";

suite("WebPushService", () => {
  let workspaceRoot: string;
  let notificationsDir: string;
  let vapidKeysPath: string;
  let subscriptionsPath: string;
  let originalFetch: typeof fetch;
  let originalCtrlyokeHome: string | undefined;

  setup(() => {
    workspaceRoot = makeTempDir("ctrlyoke-web-push-");
    originalCtrlyokeHome = process.env.CTRLYOKE_HOME;
    process.env.CTRLYOKE_HOME = workspaceRoot;
    notificationsDir = path.join(
      ctrlyokeStateHome(),
      PATH_CONSTANTS.NOTIFICATIONS_DIR
    );
    vapidKeysPath = path.join(notificationsDir, PATH_CONSTANTS.VAPID_KEYS_FILE);
    subscriptionsPath = path.join(
      notificationsDir,
      PATH_CONSTANTS.PUSH_SUBSCRIPTIONS_FILE
    );
    originalFetch = globalThis.fetch;
  });

  teardown(() => {
    globalThis.fetch = originalFetch;
    if (originalCtrlyokeHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalCtrlyokeHome;
    }
    removeTempDir(workspaceRoot);
  });

  test("generates JWK-backed VAPID keys while preserving public key output", async () => {
    const service = new WebPushService();

    const publicKey = await service.getPublicKey();
    const stored = JSON.parse(
      await fs.promises.readFile(vapidKeysPath, "utf8")
    ) as {
      publicKey: string;
      privateJwk: {
        kty: string;
        crv: string;
        x: string;
        y: string;
        d: string;
      };
    };

    assert.strictEqual(stored.publicKey, publicKey);
    assert.strictEqual(typeof stored.privateJwk.d, "string");
    assert.strictEqual(stored.privateJwk.kty, "EC");
    assert.strictEqual(stored.privateJwk.crv, "P-256");
    assert.strictEqual(typeof stored.privateJwk.x, "string");
    assert.strictEqual(typeof stored.privateJwk.y, "string");
  });

  test("does not overwrite an existing corrupt VAPID keys file", async () => {
    const service = new WebPushService();
    const corruptContent = "{ invalid json";
    await fs.promises.mkdir(notificationsDir, { recursive: true });
    await fs.promises.writeFile(vapidKeysPath, corruptContent, "utf8");

    await assert.rejects(
      () => service.getPublicKey(),
      new RegExp(
        `VAPID keys file .*${escapeRegExp(path.basename(vapidKeysPath))}.*invalid JSON`
      )
    );
    assert.strictEqual(
      await fs.promises.readFile(vapidKeysPath, "utf8"),
      corruptContent
    );
  });

  test("strips a BOM before reading VAPID keys", async () => {
    const service = new WebPushService();
    const publicKey = await service.getPublicKey();
    const stored = await fs.promises.readFile(vapidKeysPath, "utf8");
    await fs.promises.writeFile(vapidKeysPath, `\uFEFF${stored}`, "utf8");

    assert.strictEqual(await service.getPublicKey(), publicKey);
    assert.ok(
      (await fs.promises.readFile(vapidKeysPath, "utf8")).startsWith("\uFEFF")
    );
  });

  test("does not wipe corrupt subscription data when upserting", async () => {
    const service = new WebPushService();
    const corruptContent = "{ invalid json";
    await fs.promises.mkdir(notificationsDir, { recursive: true });
    await fs.promises.writeFile(subscriptionsPath, corruptContent, "utf8");
    const subscription = await createValidSubscription();

    await assert.rejects(
      () => service.upsertSubscription(subscription, {}),
      /push subscriptions file .*invalid JSON/
    );
    assert.strictEqual(
      await fs.promises.readFile(subscriptionsPath, "utf8"),
      corruptContent
    );
  });

  test("strips a BOM before reading subscriptions for an upsert", async () => {
    const service = new WebPushService();
    const existing = {
      id: "existing-device",
      endpointHash: "existing-hash",
      endpoint: "https://example.com/push/existing",
      keys: { p256dh: "public-key", auth: "auth-key" },
      createdAt: 1,
      updatedAt: 1,
    };
    await fs.promises.mkdir(notificationsDir, { recursive: true });
    await fs.promises.writeFile(
      subscriptionsPath,
      `\uFEFF${JSON.stringify({ subscriptions: [existing] })}`,
      "utf8"
    );

    await service.upsertSubscription(await createValidSubscription(), {});
    const stored = JSON.parse(
      await fs.promises.readFile(subscriptionsPath, "utf8")
    ) as { subscriptions: unknown[] };
    assert.deepStrictEqual(stored.subscriptions[0], existing);
    assert.strictEqual(stored.subscriptions.length, 2);
  });

  test("preserves invalid subscription entries through upsert and remove", async () => {
    const service = new WebPushService();
    const invalidEntry = { id: "invalid-device", unexpected: [1, "two"] };
    await fs.promises.mkdir(notificationsDir, { recursive: true });
    await fs.promises.writeFile(
      subscriptionsPath,
      JSON.stringify({ subscriptions: [invalidEntry] }),
      "utf8"
    );

    const added = await service.upsertSubscription(
      await createValidSubscription(),
      {}
    );
    await service.removeSubscription(added.id);

    const stored = JSON.parse(
      await fs.promises.readFile(subscriptionsPath, "utf8")
    ) as { subscriptions: unknown[] };
    assert.deepStrictEqual(stored.subscriptions, [invalidEntry]);
  });

  test("removes expired subscriptions when the push service returns 410", async () => {
    const service = new WebPushService();
    const subscription = await createValidSubscription();

    await service.getPublicKey();
    await service.upsertSubscription(subscription, {});
    globalThis.fetch = async () =>
      new Response("expired", {
        status: 410,
        statusText: "Gone",
      });

    const result = await service.sendNotification({
      id: "event-1",
      title: "Done",
      body: "Workflow complete",
      tag: "workflow-1",
      severity: COMPLETION_NOTIFICATION_SEVERITY.INFO,
      kind: COMPLETION_NOTIFICATION_KINDS.WORKFLOW,
      workflowId: "workflow-1",
      url: "https://example.com",
    });
    const storedRegistry = JSON.parse(
      await fs.promises.readFile(subscriptionsPath, "utf8")
    ) as { subscriptions: unknown[] };

    assert.deepStrictEqual(result, { sent: 0, removed: 1, failed: 1 });
    assert.strictEqual(storedRegistry.subscriptions.length, 0);
  });

  test("preserves a subscription upserted while a push is in flight", async () => {
    const service = new WebPushService();
    await service.getPublicKey();
    await service.upsertSubscription(await createValidSubscription(), {});

    let resolveFetch!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    let signalStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    globalThis.fetch = async (_input, init = {}) => {
      signal = init.signal as AbortSignal;
      signalStarted();
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    };

    const sending = service.sendNotification(createEvent());
    await fetchStarted;
    const added = await service.upsertSubscription(
      await createValidSubscription("https://example.com/push/concurrent"),
      {}
    );
    resolveFetch(new Response(null, { status: 201 }));
    const result = await sending;

    const storedRegistry = JSON.parse(
      await fs.promises.readFile(subscriptionsPath, "utf8")
    ) as { subscriptions: Array<{ endpointHash: string }> };
    assert.deepStrictEqual(result, { sent: 1, removed: 0, failed: 0 });
    assert.ok(
      storedRegistry.subscriptions.some(
        (subscription) => subscription.endpointHash === added.endpointHash
      )
    );
    assert.ok(signal);
  });

  test("does not hold the registry lock while sending a push", async () => {
    const service = new WebPushService();
    await service.getPublicKey();
    await service.upsertSubscription(await createValidSubscription(), {});
    let lockExistsDuringFetch = true;
    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_input, init = {}) => {
      signal = init.signal as AbortSignal;
      lockExistsDuringFetch = await fs.promises
        .access(`${subscriptionsPath}.lock`)
        .then(
          () => true,
          () => false
        );
      return new Response(null, { status: 201 });
    };

    const result = await service.sendNotification(createEvent());

    assert.deepStrictEqual(result, { sent: 1, removed: 0, failed: 0 });
    assert.strictEqual(lockExistsDuringFetch, false);
    assert.ok(signal);
  });

  test("returns one stable public key when first-use servers initialize concurrently", async () => {
    const services = Array.from({ length: 8 }, () => new WebPushService());
    const publicKeys = await Promise.all(
      services.map((service) => service.getPublicKey())
    );

    assert.ok(publicKeys.every((key) => key === publicKeys[0]));
  });

  test("blocks push setup when remote access is not entitled", async () => {
    let blocked = 0;
    const service = new WebPushService(undefined, {
      canUseRemoteAccess: async () => false,
      onAccessBlocked: () => {
        blocked += 1;
      },
    });

    await assert.rejects(() => service.getPublicKey(), /Push-to-phone/);
    assert.strictEqual(blocked, 1);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function encodeBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function createValidSubscription(
  endpoint = "https://example.com/push/123"
): Promise<WebPushSubscriptionPayload> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveBits"]
  );
  const rawPublicKey = Buffer.from(
    await crypto.subtle.exportKey("raw", keyPair.publicKey)
  );

  return {
    endpoint,
    keys: {
      p256dh: encodeBase64Url(rawPublicKey),
      auth: encodeBase64Url(Buffer.alloc(16, 0x66)),
    },
  };
}

function createEvent() {
  return {
    id: "event-1",
    title: "Done",
    body: "Workflow complete",
    tag: "workflow-1",
    severity: COMPLETION_NOTIFICATION_SEVERITY.INFO,
    kind: COMPLETION_NOTIFICATION_KINDS.WORKFLOW,
    workflowId: "workflow-1",
    url: "https://example.com",
  };
}
