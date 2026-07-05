import { buildPushHTTPRequest } from "@pushforge/builder";
import { promises as fsp } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import type { CompletionNotificationEvent } from "../ui/notifications/CompletionNotificationFactory";

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
  privateJwk: VapidPrivateJwk;
}

interface VapidPrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
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
    private readonly vapidSubject: string = "mailto:ctrlyoke@example.com" //TODO: update this with a valid support email when we get one
  ) {
    this.notificationsDir = path.join(
      workspaceRoot,
      PATH_CONSTANTS.CTRLYOKE_DIR,
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
          const { endpoint, headers, body } = await buildPushHTTPRequest({
            privateJWK: keys.privateJwk,
            subscription: {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
            },
            message: {
              payload: JSON.parse(payload),
              adminContact: this.vapidSubject,
              options: { ttl: 60 },
            },
          });
          const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body,
          });
          if (!response.ok) {
            throw new PushDeliveryError(
              response.status,
              await safeReadResponseText(response)
            );
          }
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
      if (isStoredVapidKeys(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through and generate new keys.
    }

    const generated = await generateVapidKeys();
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

  private async writeSubscriptions(
    registry: StoredPushRegistry
  ): Promise<void> {
    await atomicWriteJson(this.subscriptionsPath, registry);
  }
}

function hashEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function isStoredVapidKeys(value: unknown): value is StoredVapidKeys {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredVapidKeys>;
  return Boolean(
    typeof candidate.publicKey === "string" &&
      isVapidPrivateJwk(candidate.privateJwk)
  );
}

function isVapidPrivateJwk(value: unknown): value is VapidPrivateJwk {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<VapidPrivateJwk>;
  return (
    candidate.kty === "EC" &&
    candidate.crv === "P-256" &&
    typeof candidate.x === "string" &&
    typeof candidate.y === "string" &&
    typeof candidate.d === "string"
  );
}

async function generateVapidKeys(): Promise<StoredVapidKeys> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  );

  const privateJwk = (await crypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey
  )) as Partial<VapidPrivateJwk>;
  if (!isVapidPrivateJwk(privateJwk)) {
    throw new Error("Failed to export generated VAPID key as a valid JWK");
  }

  return {
    publicKey: encodePublicKeyFromJwk(privateJwk),
    privateJwk,
  };
}

function encodePublicKeyFromJwk(privateJwk: VapidPrivateJwk): string {
  if (
    typeof privateJwk.x !== "string" ||
    typeof privateJwk.y !== "string"
  ) {
    throw new Error("VAPID private JWK is missing public coordinates");
  }

  const x = decodeBase64Url(privateJwk.x);
  const y = decodeBase64Url(privateJwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("VAPID public coordinates must be 32 bytes each");
  }

  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return encodeBase64Url(publicKey);
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(normalized + padding, "base64"));
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

class PushDeliveryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message || `Push service responded with status ${statusCode}`);
  }
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

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
