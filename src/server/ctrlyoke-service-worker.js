self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "__CTRLYOKE_CLEAR_BADGE_MESSAGE_TYPE__") {
    event.waitUntil(safeClearBadgeState());
    return;
  }
  if (data.type === "__CTRLYOKE_INCREMENT_BADGE_MESSAGE_TYPE__") {
    event.waitUntil(safeIncrementBadgeCount(data.eventId));
  }
});

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title || "ctrlyoke", {
        body: payload.body || "Workflow update available",
        icon: "__CTRLYOKE_NOTIFICATION_ICON_PATH__",
        badge: "__CTRLYOKE_NOTIFICATION_BADGE_PATH__",
        tag: payload.tag,
        data: { url: payload.url || "/" },
      }),
      safeIncrementBadgeCount(payload.id),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  const targetUrl = event.notification?.data?.url || "/";
  event.notification?.close();
  event.waitUntil(
    Promise.all([
      safeClearBadgeState(),
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          for (const client of clients) {
            if ("focus" in client) {
              client.navigate(targetUrl);
              return client.focus();
            }
          }
          return self.clients.openWindow(targetUrl);
        }),
    ])
  );
});

const BADGE_DB_NAME = "ctrlyoke-notifications";
const BADGE_STORE_NAME = "badge-state";
const BADGE_STATE_KEY = "app";
const MAX_SEEN_EVENT_IDS = 200;

async function safeIncrementBadgeCount(eventId) {
  try {
    await incrementBadgeCount(eventId);
  } catch {
    // Best-effort badge tracking must not fail the notification itself.
  }
}

async function safeClearBadgeState() {
  try {
    await clearBadgeState();
  } catch {
    // Best-effort badge clearing must not block notification click handling.
  }
}

async function incrementBadgeCount(eventId) {
  await updateBadgeState((state) => {
    if (typeof eventId === "string" && state.seenEventIds.includes(eventId)) {
      return state;
    }
    const seenEventIds =
      typeof eventId === "string" && eventId
        ? [...state.seenEventIds.filter((id) => id !== eventId), eventId].slice(
            -MAX_SEEN_EVENT_IDS
          )
        : state.seenEventIds;
    return {
      unreadCount: state.unreadCount + 1,
      seenEventIds,
    };
  });
}

async function clearBadgeState() {
  await updateBadgeState(() => ({
    unreadCount: 0,
    seenEventIds: [],
  }));
}

async function updateBadgeState(updater) {
  const db = await openBadgeDb();
  try {
    const transaction = db.transaction(BADGE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(BADGE_STORE_NAME);
    const currentState = await readBadgeState(store);
    const nextState = normalizeBadgeState(updater(currentState));
    await requestToPromise(store.put(nextState, BADGE_STATE_KEY));
    await transactionDone(transaction);
    await applyAppBadge(nextState.unreadCount);
  } finally {
    db.close();
  }
}

function openBadgeDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BADGE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BADGE_STORE_NAME)) {
        db.createObjectStore(BADGE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Failed to open badge database"));
  });
}

async function readBadgeState(store) {
  const stored = await requestToPromise(store.get(BADGE_STATE_KEY));
  return normalizeBadgeState(stored);
}

function normalizeBadgeState(value) {
  return {
    unreadCount:
      typeof value?.unreadCount === "number" && value.unreadCount > 0
        ? Math.floor(value.unreadCount)
        : 0,
    seenEventIds: Array.isArray(value?.seenEventIds)
      ? value.seenEventIds
          .filter((item) => typeof item === "string")
          .slice(-MAX_SEEN_EVENT_IDS)
      : [],
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed"));
  });
}

async function applyAppBadge(unreadCount) {
  if (unreadCount > 0 && navigator.setAppBadge) {
    try {
      await navigator.setAppBadge(unreadCount);
    } catch {
      // Ignore unsupported badge writes.
    }
    return;
  }
  if (unreadCount === 0 && navigator.clearAppBadge) {
    try {
      await navigator.clearAppBadge();
    } catch {
      // Ignore unsupported badge clears.
    }
  }
}
