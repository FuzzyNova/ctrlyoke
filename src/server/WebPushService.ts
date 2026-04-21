import { promises as fsp } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import type { CompletionNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";

type WebPushModule = {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string
  ): void;
  sendNotification(
    subscription: WebPushSubscriptionPayload,
    payload?: string,
    options?: { TTL?: number }
  ): Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webPush = require("web-push") as WebPushModule;

export interface WebPushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface StoredPushSubscription extends WebPushSubscriptionPayload {
  id: string;
  endpointHash: string;
  createdAt: number;
  updatedAt: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastFailureStatus?: number;
  lastFailureMessage?: string;
  userAgent?: string;
  label?: string;
}

interface StoredVapidKeys {
  publicKey: string;
  privateKey: string;
}

interface StoredPushRegistry {
  subscriptions: StoredPushSubscription[];
}

export interface PushSubscriptionListResult {
  subscriptions: Array<
    Pick<
      StoredPushSubscription,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "lastSuccessAt"
      | "lastFailureAt"
      | "lastFailureStatus"
      | "userAgent"
      | "label"
    > & { stale: boolean }
  >;
  subscriptionCount: number;
  staleSubscriptionCount: number;
}

export class WebPushService {
  private readonly notificationsDir: string;
  private readonly vapidKeysPath: string;
  private readonly subscriptionsPath: string;
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    workspaceRoot: string,
    private readonly vapidSubject: string = "mailto:flightpath@local"
  ) {
    this.notificationsDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.NOTIFICATIONS_DIR
    );
    this.vapidKeysPath = path.join(
      this.notificationsDir,
      PATH_CONSTANTS.VAPID_KEYS_FILE
    );
    this.subscriptionsPath = path.join(
      this.notificationsDir,
      PATH_CONSTANTS.PUSH_SUBSCRIPTIONS_FILE
    );
  }

  async getPublicKey(): Promise<string> {
    return (await this.getOrCreateVapidKeys()).publicKey;
  }

  async listSubscriptions(): Promise<PushSubscriptionListResult> {
    return this.withSerializedAccess(async () => {
      const registry = await this.readSubscriptions();
      const subscriptions = registry.subscriptions.map((subscription) => ({
        id: subscription.id,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
        lastSuccessAt: subscription.lastSuccessAt,
        lastFailureAt: subscription.lastFailureAt,
        lastFailureStatus: subscription.lastFailureStatus,
        userAgent: subscription.userAgent,
        label: subscription.label,
        stale: isSubscriptionStale(subscription),
      }));

      return {
        subscriptions,
        subscriptionCount: subscriptions.length,
        staleSubscriptionCount: subscriptions.filter((s) => s.stale).length,
      };
    });
  }

  async upsertSubscription(
    subscription: WebPushSubscriptionPayload,
    metadata: { userAgent?: string; label?: string }
  ): Promise<StoredPushSubscription> {
    return this.withSerializedAccess(async () => {
      const registry = await this.readSubscriptions();
      const now = Date.now();
      const endpointHash = hashEndpoint(subscription.endpoint);
      const existing = registry.subscriptions.find(
        (item) => item.endpointHash === endpointHash
      );

      const next: StoredPushSubscription = {
        ...(existing ?? {
          id: endpointHash,
          createdAt: now,
        }),
        endpoint: subscription.endpoint,
        endpointHash,
        expirationTime: subscription.expirationTime,
        keys: subscription.keys,
        updatedAt: now,
        userAgent: metadata.userAgent,
        label: metadata.label,
      };

      if (existing) {
        registry.subscriptions = registry.subscriptions.map((item) =>
          item.id === existing.id ? next : item
        );
      } else {
        registry.subscriptions.push(next);
      }

      await this.writeSubscriptions(registry);
      return next;
    });
  }

  async removeSubscription(id: string): Promise<boolean> {
    return this.withSerializedAccess(async () => {
      const registry = await this.readSubscriptions();
      const before = registry.subscriptions.length;
      registry.subscriptions = registry.subscriptions.filter(
        (subscription) => subscription.id !== id
      );
      if (registry.subscriptions.length === before) {
        return false;
      }
      await this.writeSubscriptions(registry);
      return true;
    });
  }

  async sendNotification(
    event: CompletionNotificationEvent
  ): Promise<{ sent: number; removed: number; failed: number }> {
    return this.withSerializedAccess(async () => {
      const registry = await this.readSubscriptions();
      if (registry.subscriptions.length === 0) {
        return { sent: 0, removed: 0, failed: 0 };
      }

      const keys = await this.getOrCreateVapidKeys();
      webPush.setVapidDetails(
        this.vapidSubject,
        keys.publicKey,
        keys.privateKey
      );

      const payload = JSON.stringify({
        id: event.id,
        title: event.title,
        body: event.body,
        tag: event.tag,
        severity: event.severity,
        kind: event.kind,
        url: event.url,
      });

      let sent = 0;
      let removed = 0;
      let failed = 0;
      const survivors: StoredPushSubscription[] = [];

      for (const subscription of registry.subscriptions) {
        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              expirationTime: subscription.expirationTime,
              keys: subscription.keys,
            },
            payload,
            { TTL: 60 }
          );
          sent += 1;
          survivors.push({
            ...subscription,
            lastSuccessAt: Date.now(),
            lastFailureAt: undefined,
            lastFailureStatus: undefined,
            lastFailureMessage: undefined,
            updatedAt: Date.now(),
          });
        } catch (error) {
          failed += 1;
          const statusCode = getStatusCode(error);
          const redactedHash = subscription.endpointHash.slice(0, 12);

          if (statusCode === 404 || statusCode === 410) {
            removed += 1;
            Log.info(
              `[WebPushService] removed expired push subscription ${redactedHash} status=${statusCode}`
            );
            continue;
          }

          Log.warn(
            `[WebPushService] push send failed for ${redactedHash} status=${statusCode ?? "unknown"}`
          );
          survivors.push({
            ...subscription,
            lastFailureAt: Date.now(),
            lastFailureStatus: statusCode,
            lastFailureMessage: getErrorMessage(error),
            updatedAt: Date.now(),
          });
        }
      }

      registry.subscriptions = survivors;
      await this.writeSubscriptions(registry);
      return { sent, removed, failed };
    });
  }

  private async withSerializedAccess<T>(action: () => Promise<T>): Promise<T> {
    const scheduled = this.operationQueue.then(action, action);
    this.operationQueue = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }

  private async getOrCreateVapidKeys(): Promise<StoredVapidKeys> {
    await ensureDirectory(this.notificationsDir);

    try {
      const content = await fsp.readFile(this.vapidKeysPath, "utf8");
      const parsed = JSON.parse(content) as Partial<StoredVapidKeys>;
      if (parsed.publicKey && parsed.privateKey) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        };
      }
    } catch {
      // Fall through and generate new keys.
    }

    const generated = webPush.generateVAPIDKeys();
    await atomicWriteJson(this.vapidKeysPath, generated);
    return generated;
  }

  private async readSubscriptions(): Promise<StoredPushRegistry> {
    await ensureDirectory(this.notificationsDir);

    try {
      const content = await fsp.readFile(this.subscriptionsPath, "utf8");
      const parsed = JSON.parse(content) as Partial<StoredPushRegistry>;
      return {
        subscriptions: Array.isArray(parsed.subscriptions)
          ? parsed.subscriptions.filter(isValidStoredSubscription)
          : [],
      };
    } catch {
      return { subscriptions: [] };
    }
  }

  private async writeSubscriptions(registry: StoredPushRegistry): Promise<void> {
    await atomicWriteJson(this.subscriptionsPath, registry);
  }
}

function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function isValidStoredSubscription(
  value: unknown
): value is StoredPushSubscription {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredPushSubscription>;
  return Boolean(
    candidate.id &&
      candidate.endpoint &&
      candidate.endpointHash &&
      candidate.keys?.auth &&
      candidate.keys?.p256dh
  );
}

function isSubscriptionStale(subscription: StoredPushSubscription): boolean {
  if (!subscription.lastFailureAt) {
    return false;
  }

  if (!subscription.lastSuccessAt) {
    return true;
  }

  return subscription.lastFailureAt > subscription.lastSuccessAt;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function atomicWriteJson(
  targetPath: string,
  value: unknown
): Promise<void> {
  await ensureDirectory(path.dirname(targetPath));
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(tempPath, targetPath);
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { statusCode?: number };
  return typeof candidate.statusCode === "number"
    ? candidate.statusCode
    : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
