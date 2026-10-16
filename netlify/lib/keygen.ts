// Keygen admin-API helpers shared by the Netlify functions. Server-side only:
// every call authenticates with KEYGEN_ADMIN_TOKEN, which must never ship in
// the VSIX or the static site.
import { KEYGEN_API_BASE_URL } from "../../src/license/KeygenConstants";

// Keys into the Keygen license's `metadata` bag — single-sourced so every path
// that reads or writes metadata can never drift out of sync. Keygen's metadata
// writes replace the whole object, so every writer must merge existing keys in.
// DPA.md Annex III limits what Keygen may hold to names, business email,
// order/subscription identifiers and license data: never store the Enterprise
// customer's legal name, address, or terms-acceptance record here (the Lemon
// Squeezy order holds those).
export const LICENSE_METADATA_KEY = {
  LS_ORDER_ID: "lsOrderId",
  LS_SUBSCRIPTION_ID: "lsSubscriptionId",
  LS_SUBSCRIPTION_STATUS: "lsSubscriptionStatus",
  LS_SUBSCRIPTION_RENEWS_AT: "lsSubscriptionRenewsAt",
  LS_SUBSCRIPTION_UPDATED_AT: "lsSubscriptionUpdatedAt",
  LAST_RENEWED_INVOICE_ID: "lastRenewedInvoiceId",
  REFUND_NOTIFIED_ID: "refundNotifiedId",
  RENEWAL_NOTICE_SENT_FOR: "renewalNoticeSentFor",
  MACHINE_ALERT_LEVEL: "machineAlertLevel",
  BUYER_EMAIL: "buyerEmail",
  BUYER_NAME: "buyerName",
} as const;

export interface KeygenLicense {
  id: string;
  attributes: {
    key: string;
    expiry: string | null;
    status: string;
    suspended: boolean;
    /** Inherited from the policy unless overridden; null means no limit. */
    maxMachines: number | null;
    metadata: Record<string, unknown>;
  };
  relationships: {
    policy: { data: { id: string } | null };
    machines: { meta?: { count?: number } };
  };
}

/** Keygen license `status` values a renewal or reminder must not act on. */
export const KEYGEN_INACTIVE_LICENSE_STATUSES: ReadonlySet<string> = new Set([
  "EXPIRED",
  "SUSPENDED",
  "BANNED",
]);

export async function keygenFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${KEYGEN_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.KEYGEN_ADMIN_TOKEN}`,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
      ...init.headers,
    },
  });
}

/** Idempotency / correlation lookup: find the license carrying a given metadata key/value pair. */
export async function findLicenseByMetadata(
  metadataKey: string,
  value: string
): Promise<KeygenLicense | null> {
  const query = `metadata[${metadataKey}]=${encodeURIComponent(value)}`;
  const res = await keygenFetch(`/licenses?${query}`);
  if (!res.ok) {
    throw new Error(
      `Keygen license lookup failed: ${res.status} ${await res.text()}`
    );
  }
  const body = (await res.json()) as { data: KeygenLicense[] };
  return body.data[0] ?? null;
}

export async function getLicense(licenseId: string): Promise<KeygenLicense> {
  const res = await keygenFetch(`/licenses/${encodeURIComponent(licenseId)}`);
  if (!res.ok) {
    throw new Error(
      `Keygen license fetch failed: ${res.status} ${await res.text()}`
    );
  }
  const body = (await res.json()) as { data: KeygenLicense };
  return body.data;
}

const KEYGEN_PAGE_SIZE = 100;

/** Every license on a policy, following Keygen's page-number pagination. */
export async function listLicensesForPolicy(
  policyId: string
): Promise<KeygenLicense[]> {
  const licenses: KeygenLicense[] = [];
  for (let page = 1; ; page++) {
    const res = await keygenFetch(
      `/licenses?policy=${encodeURIComponent(policyId)}&page[size]=${KEYGEN_PAGE_SIZE}&page[number]=${page}`
    );
    if (!res.ok) {
      throw new Error(
        `Keygen license list failed: ${res.status} ${await res.text()}`
      );
    }
    const body = (await res.json()) as { data: KeygenLicense[] };
    licenses.push(...body.data);
    if (body.data.length < KEYGEN_PAGE_SIZE) return licenses;
  }
}

/** Keygen metadata writes replace the whole object — always merge existing keys in. */
export async function updateLicenseMetadata(
  license: KeygenLicense,
  patch: Record<string, unknown>
): Promise<void> {
  const res = await keygenFetch(`/licenses/${license.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "licenses",
        attributes: {
          metadata: { ...license.attributes.metadata, ...patch },
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Keygen license metadata update failed: ${res.status} ${await res.text()}`
    );
  }
}

/** Reads a string-valued metadata entry, treating anything else as absent. */
export function metadataString(
  license: KeygenLicense,
  key: string
): string | undefined {
  const value = license.attributes.metadata[key];
  return typeof value === "string" && value ? value : undefined;
}
