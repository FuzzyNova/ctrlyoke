import {
  BROWSER_NOTIFICATION_MODES,
  COMPLETION_NOTIFICATION_SEVERITY,
  HOSTED_ICON_PATHS,
  SERVICE_WORKER_BADGE_MESSAGE_TYPES,
  type BrowserNotificationMode,
  type ServiceWorkerBadgeMessageType,
} from "@root/types/DashboardConstants";
import type {
  CompletionNotificationEventPayload,
  FullGlobalSettings,
} from "@root/types/WebviewMessageTypes";
import { isStandalone } from "@hooks/useVsCodeApi";

const PUSH_SUBSCRIPTION_ID_KEY = "ctrlyoke-push-subscription-id";

export type BrowserPermissionStatus =
  | "unsupported"
  | "blocked"
  | "needs-permission"
  | "granted";

export interface BrowserNotificationStatus {
  supported: boolean;
  permission: BrowserPermissionStatus;
  secureContext: boolean;
  serviceWorkerSupported: boolean;
  pushSupported: boolean;
  subscribed: boolean;
  subscriptionCount?: number;
  staleSubscriptionCount?: number;
}

interface PushSubscriptionResponse {
  id: string;
}

interface PushSubscriptionListResponse {
  subscriptionCount: number;
  staleSubscriptionCount: number;
}

interface VapidPublicKeyResponse {
  publicKey: string;
}

export async function getBrowserNotificationStatus(): Promise<BrowserNotificationStatus> {
  const permission = getPermissionStatus();
  const serviceWorkerSupported =
    typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const pushSupported =
    serviceWorkerSupported &&
    typeof window !== "undefined" &&
    "PushManager" in window;

  const status: BrowserNotificationStatus = {
    supported: permission !== "unsupported",
    permission,
    secureContext: window.isSecureContext,
    serviceWorkerSupported,
    pushSupported,
    subscribed: false,
  };

  if (!isStandalone || !pushSupported || !window.isSecureContext) {
    return status;
  }

  try {
    const registration = await ensureServiceWorkerRegistration();
    const subscription = await registration.pushManager.getSubscription();
    const list = await fetchSubscriptionList();
    return {
      ...status,
      subscribed: Boolean(subscription),
      subscriptionCount: list.subscriptionCount,
      staleSubscriptionCount: list.staleSubscriptionCount,
    };
  } catch {
    return status;
  }
}

export async function enableBrowserNotifications(
  mode: BrowserNotificationMode
): Promise<BrowserNotificationStatus> {
  if (typeof Notification === "undefined") {
    return getBrowserNotificationStatus();
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return getBrowserNotificationStatus();
  }

  if (mode === BROWSER_NOTIFICATION_MODES.PUSH && isStandalone) {
    await subscribeForPushNotifications();
  } else if (
    isStandalone &&
    window.isSecureContext &&
    "serviceWorker" in navigator
  ) {
    // Register early so connected notifications can prefer showNotification().
    await ensureServiceWorkerRegistration();
  }

  return getBrowserNotificationStatus();
}

export async function disablePushNotifications(): Promise<BrowserNotificationStatus> {
  if (!isStandalone || !("serviceWorker" in navigator)) {
    return getBrowserNotificationStatus();
  }

  try {
    const registration = await ensureServiceWorkerRegistration();
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
    }

    const subscriptionId = localStorage.getItem(PUSH_SUBSCRIPTION_ID_KEY);
    if (subscriptionId) {
      await apiFetch(
        `/api/notifications/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: "DELETE",
        }
      );
      localStorage.removeItem(PUSH_SUBSCRIPTION_ID_KEY);
    }
  } catch {
    // Best-effort cleanup.
  }

  return getBrowserNotificationStatus();
}

export async function clearNotificationBadgeCount(): Promise<void> {
  const clearedViaWorker = await postBadgeMessageToServiceWorker(
    SERVICE_WORKER_BADGE_MESSAGE_TYPES.CLEAR_NOTIFICATION_BADGE,
    undefined,
    false
  );
  if (clearedViaWorker) {
    return;
  }

  if ("clearAppBadge" in navigator) {
    await navigator.clearAppBadge().catch(() => {});
  }
}

export async function handleCompletionNotificationEvent(
  event: CompletionNotificationEventPayload,
  fullSettings: FullGlobalSettings | null
): Promise<void> {
  const browserSettings = fullSettings?.settings.notifications?.browser;
  if (
    !browserSettings ||
    browserSettings.mode === BROWSER_NOTIFICATION_MODES.NEVER
  ) {
    return;
  }

  if (
    fullSettings?.settings.notifications.onlyWhenWindowUnfocused &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  ) {
    return;
  }

  const status = await getBrowserNotificationStatus();
  if (status.permission !== "granted") {
    return;
  }

  const shouldDeliverConnected =
    browserSettings.mode === BROWSER_NOTIFICATION_MODES.CONNECTED_ONLY ||
    (browserSettings.mode === BROWSER_NOTIFICATION_MODES.PUSH &&
      !status.subscribed);

  if (!shouldDeliverConnected) {
    return;
  }

  await showSystemNotification(event);
}

async function subscribeForPushNotifications(): Promise<void> {
  const registration = await ensureServiceWorkerRegistration();
  let subscription = await registration.pushManager.getSubscription();

  if (!subscription) {
    const vapid = await apiFetchJson<VapidPublicKeyResponse>(
      "/api/notifications/vapid-public-key"
    );
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(
        vapid.publicKey
      ) as BufferSource,
    });
  }

  const response = await apiFetchJson<PushSubscriptionResponse>(
    "/api/notifications/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        subscription: subscription.toJSON(),
      }),
    }
  );
  localStorage.setItem(PUSH_SUBSCRIPTION_ID_KEY, response.id);
}

async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) {
    return existing;
  }

  return navigator.serviceWorker.register("/ctrlyoke-service-worker.js", {
    scope: "/",
  });
}

async function fetchSubscriptionList(): Promise<PushSubscriptionListResponse> {
  return apiFetchJson<PushSubscriptionListResponse>(
    "/api/notifications/subscriptions"
  );
}

async function showSystemNotification(
  event: CompletionNotificationEventPayload
): Promise<void> {
  const notificationOptions: NotificationOptions = {
    body: event.body,
    icon: HOSTED_ICON_PATHS.APP_ICON_PNG,
    badge: HOSTED_ICON_PATHS.FAVICON_PNG,
    tag: event.tag,
    data: {
      url: event.url,
    },
  };

  if (isStandalone && "serviceWorker" in navigator && window.isSecureContext) {
    try {
      const registration = await ensureServiceWorkerRegistration();
      await registration.showNotification(event.title, notificationOptions);
      await incrementNotificationBadgeCount(event.id);
      return;
    } catch {
      // Fall through to the Notification constructor.
    }
  }

  const notification = new Notification(event.title, notificationOptions);
  await incrementNotificationBadgeCount(event.id);
  notification.onclick = () => {
    notification.close();
    if (event.url) {
      window.open(event.url, "_blank", "noopener,noreferrer");
    } else {
      window.focus();
    }
  };
}

async function incrementNotificationBadgeCount(eventId: string): Promise<void> {
  const incrementedViaWorker = await postBadgeMessageToServiceWorker(
    SERVICE_WORKER_BADGE_MESSAGE_TYPES.INCREMENT_NOTIFICATION_BADGE,
    eventId,
    true
  );
  if (incrementedViaWorker) {
    return;
  }

  if ("setAppBadge" in navigator) {
    await navigator.setAppBadge(1).catch(() => {});
  }
}

async function postBadgeMessageToServiceWorker(
  type: ServiceWorkerBadgeMessageType,
  eventId?: string,
  createIfMissing: boolean = false
): Promise<boolean> {
  if (
    !isStandalone ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator)
  ) {
    return false;
  }

  try {
    const registration = createIfMissing
      ? await ensureServiceWorkerRegistration()
      : await navigator.serviceWorker.getRegistration("/");
    let worker = registration?.active ?? null;
    if (!worker && createIfMissing) {
      worker = (await navigator.serviceWorker.ready).active;
    }
    if (!worker) {
      return false;
    }

    worker.postMessage({
      type,
      ...(eventId ? { eventId } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

function getPermissionStatus(): BrowserPermissionStatus {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }

  switch (Notification.permission) {
    case "granted":
      return "granted";
    case "denied":
      return "blocked";
    default:
      return "needs-permission";
  }
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const token = new URLSearchParams(window.location.search).get("token");
  if (token) {
    headers.set("x-ctrlyoke-token", token);
  }
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Notification request failed: ${response.status}`);
  }

  return response;
}

async function apiFetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(input, init);
  return (await response.json()) as T;
}

function base64UrlToUint8Array(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const normalized = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = window.atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function getNotificationSeverityColor(
  severity: CompletionNotificationEventPayload["severity"]
): "info" | "success" | "warning" | "error" {
  if (severity === COMPLETION_NOTIFICATION_SEVERITY.ERROR) {
    return "error";
  }
  if (severity === COMPLETION_NOTIFICATION_SEVERITY.WARNING) {
    return "warning";
  }
  return "info";
}
