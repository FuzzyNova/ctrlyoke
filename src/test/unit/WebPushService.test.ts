import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
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

  setup(async () => {
    workspaceRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-web-push-")
    );
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

  teardown(async () => {
    globalThis.fetch = originalFetch;
    if (originalCtrlyokeHome === undefined) {
      delete process.env.CTRLYOKE_HOME;
    } else {
      process.env.CTRLYOKE_HOME = originalCtrlyokeHome;
    }
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
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
      hasRemoteAccess: async () => false,
      onAccessBlocked: () => {
        blocked += 1;
      },
    });

    await assert.rejects(() => service.getPublicKey(), /Push-to-phone/);
    assert.strictEqual(blocked, 1);
  });
});

function encodeBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function createValidSubscription(): Promise<WebPushSubscriptionPayload> {
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
    endpoint: "https://example.com/push/123",
    keys: {
      p256dh: encodeBase64Url(rawPublicKey),
      auth: encodeBase64Url(Buffer.alloc(16, 0x66)),
    },
  };
}
