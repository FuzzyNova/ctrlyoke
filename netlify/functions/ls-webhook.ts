// Glue between Lemon Squeezy (checkout/MoR) and Keygen (licensing) — see
// dev/implemented/PRO_LICENSE_PLAN.md §1.1-1.2 for the architecture this implements.
//
// order_created -> create a Keygen license (idempotent on the LS order id), email
//                  the key. Routes to the Pro or Enterprise Keygen policy based on
//                  which LS product/variant was purchased (see KEYGEN_POLICY_BY_LS_VARIANT).
// order_refunded -> on a full refund, suspend the Keygen license issued for that
//                  order and email the buyer a refund confirmation. Partial refunds (goodwill credits, tax-only refunds) are
//                  ignored — the buyer still holds a paid license.
// subscription_created -> link the LS subscription id onto the license created by
//                  order_created, so later renewal events can find it.
// subscription_payment_success -> on a "renewal" invoice (not "initial"/"updated"),
//                  extend the license's expiry via Keygen's renew action.
// subscription_payment_refunded -> on a full refund of an "initial" or "renewal"
//                  invoice, suspend the subscription's license and email the
//                  buyer; otherwise a refunded
//                  renewal would leave the license extended for another year.
// subscription_cancelled / subscription_expired -> deliberate no-op; every
//                  subscription policy uses Restrict Access expiration, so the
//                  license already locks itself out at term end.
//
// Required env vars (Netlify site settings, never committed):
//   LEMONSQUEEZY_WEBHOOK_SECRET  - HMAC secret set when the LS webhook was created
//   KEYGEN_ADMIN_TOKEN           - "fuzzynova-admin" Keygen admin token (see RELEASE_CHECKLIST.md 4.2)
//   RESEND_API_KEY               - Resend API key for sending the license-delivery email
import * as crypto from "node:crypto";

// Not secret — Keygen account/policy ids and LS product/variant ids are stable
// identifiers, not credentials. See RELEASE_CHECKLIST.md §4.1/§4.4 for where these
// come from.
const KEYGEN_ACCOUNT_ID = "6ed6209c-6633-4444-9d43-ab4a473e2f28";
const KEYGEN_PRO_POLICY_ID = "da0764ce-6577-419a-862d-128efdbfc329";
const KEYGEN_ENTERPRISE_POLICY_ID = "1700d3bb-06b7-4087-96ce-e08aa6c6a817";
const KEYGEN_API_BASE = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;

const RESEND_FROM = "ctrlyoke <licensing@ctrlyoke.dev>";
const BILLING_EMAIL = "billing@ctrlyoke.dev";

// LS variant ids (Settings → Products → each product's default "Default" variant).
// Route by variant_id rather than product_id: it's present directly on both the
// Order and Subscription webhook resources, and each product has exactly one variant.
const LS_VARIANT_ID = {
  PRO: 2059579,
  ENTERPRISE: 2105478,
} as const;

// Single source of truth for "which LS purchase issues which Keygen license type".
// The Enterprise policy's own 1-year duration (Expiration Basis: From Creation)
// is what gives an Enterprise license its 1yr initial expiry — no separate expiry
// needs to be passed at issuance here.
const KEYGEN_POLICY_BY_LS_VARIANT: Record<number, string> = {
  [LS_VARIANT_ID.PRO]: KEYGEN_PRO_POLICY_ID,
  [LS_VARIANT_ID.ENTERPRISE]: KEYGEN_ENTERPRISE_POLICY_ID,
};

const LS_EVENT = {
  ORDER_CREATED: "order_created",
  ORDER_REFUNDED: "order_refunded",
  SUBSCRIPTION_CREATED: "subscription_created",
  SUBSCRIPTION_PAYMENT_SUCCESS: "subscription_payment_success",
  SUBSCRIPTION_PAYMENT_REFUNDED: "subscription_payment_refunded",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  SUBSCRIPTION_EXPIRED: "subscription_expired",
} as const;

// LS subscription-invoice `billing_reason` values (subscription_payment_success
// fires for all three; only a renewal should extend a license's expiry — the
// initial invoice's license was already just created by order_created, and an
// "updated" invoice is a plan-change proration, not a renewal cycle).
const LS_BILLING_REASON = {
  INITIAL: "initial",
  RENEWAL: "renewal",
  UPDATED: "updated",
} as const;

// Keys into the Keygen license's `metadata` bag — single-sourced so every path
// that reads or writes metadata can never drift out of sync. Keygen's metadata
// writes replace the whole object, so every writer must merge existing keys in.
const LICENSE_METADATA_KEY = {
  LS_ORDER_ID: "lsOrderId",
  LS_SUBSCRIPTION_ID: "lsSubscriptionId",
  LAST_RENEWED_INVOICE_ID: "lastRenewedInvoiceId",
  REFUND_NOTIFIED_ID: "refundNotifiedId",
  BUYER_EMAIL: "buyerEmail",
  BUYER_NAME: "buyerName",
} as const;

interface LemonSqueezyOrderPayload {
  meta: {
    event_name: typeof LS_EVENT.ORDER_CREATED | typeof LS_EVENT.ORDER_REFUNDED;
  };
  data: {
    id: string;
    attributes: {
      user_email: string;
      user_name: string;
      status: string;
      /** True only for a full refund; a partial refund leaves this false. */
      refunded: boolean;
      first_order_item: {
        product_id: number;
        variant_id: number;
      };
    };
  };
}

interface LemonSqueezySubscriptionPayload {
  meta: {
    event_name:
      | typeof LS_EVENT.SUBSCRIPTION_CREATED
      | typeof LS_EVENT.SUBSCRIPTION_CANCELLED
      | typeof LS_EVENT.SUBSCRIPTION_EXPIRED;
  };
  data: {
    id: string;
    attributes: {
      order_id: number;
      product_id: number;
      variant_id: number;
      status: string;
    };
  };
}

interface LemonSqueezySubscriptionInvoicePayload {
  meta: {
    event_name:
      | typeof LS_EVENT.SUBSCRIPTION_PAYMENT_SUCCESS
      | typeof LS_EVENT.SUBSCRIPTION_PAYMENT_REFUNDED;
  };
  data: {
    id: string;
    attributes: {
      subscription_id: number;
      billing_reason: string;
      status: string;
      /** True only for a full refund; a partial refund leaves this false. */
      refunded: boolean;
    };
  };
}

interface KeygenLicense {
  id: string;
  attributes: { key: string; metadata: Record<string, unknown> };
}

function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signatureHeader, "utf8");
  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

async function keygenFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${KEYGEN_API_BASE}${path}`, {
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
async function findLicenseByMetadata(
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

/** Keygen metadata writes replace the whole object — always merge existing keys in. */
async function updateLicenseMetadata(
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

async function createLicense(
  policyId: string,
  orderId: string,
  email: string,
  name: string
): Promise<KeygenLicense> {
  const res = await keygenFetch("/licenses", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "licenses",
        attributes: {
          metadata: {
            [LICENSE_METADATA_KEY.LS_ORDER_ID]: orderId,
            [LICENSE_METADATA_KEY.BUYER_EMAIL]: email,
            [LICENSE_METADATA_KEY.BUYER_NAME]: name,
          },
        },
        relationships: {
          policy: { data: { type: "policies", id: policyId } },
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Keygen license creation failed: ${res.status} ${await res.text()}`
    );
  }
  const body = (await res.json()) as { data: KeygenLicense };
  return body.data;
}

/**
 * Look up the license correlated with a fully refunded LS order/subscription
 * invoice, suspend it, and email the buyer a refund confirmation. A refund for
 * a purchase that never issued a license is a no-op.
 *
 * `refundId` (the refunded order or invoice id) makes the email idempotent: it
 * is recorded on the license only after a successful send, so a retried webhook
 * re-suspends harmlessly and re-sends only if the earlier send failed.
 */
async function revokeRefundedLicense(
  metadataKey: string,
  value: string,
  refundId: string
): Promise<void> {
  const license = await findLicenseByMetadata(metadataKey, value);
  if (!license) return;
  const res = await keygenFetch(`/licenses/${license.id}/actions/suspend`, {
    method: "POST",
  });
  // 400 == already suspended (a retried refund webhook); anything else is a real failure.
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Keygen license suspend failed: ${res.status} ${await res.text()}`
    );
  }
  const { metadata } = license.attributes;
  if (metadata[LICENSE_METADATA_KEY.REFUND_NOTIFIED_ID] === refundId) return;
  const email = metadata[LICENSE_METADATA_KEY.BUYER_EMAIL];
  if (typeof email === "string" && email) {
    const name = metadata[LICENSE_METADATA_KEY.BUYER_NAME];
    await sendRefundEmail(email, typeof name === "string" ? name : "");
  }
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.REFUND_NOTIFIED_ID]: refundId,
  });
}

/**
 * LS sends subscription_created "alongside" order_created but doesn't guarantee
 * ordering, so if the license isn't there yet this throws and lets LS's webhook
 * retry catch it up — the same self-healing idempotency shape as the rest of
 * this file, not a special case.
 */
async function linkSubscriptionToLicense(
  orderId: string,
  subscriptionId: string
): Promise<void> {
  const license = await findLicenseByMetadata(
    LICENSE_METADATA_KEY.LS_ORDER_ID,
    orderId
  );
  if (!license) {
    throw new Error(
      `No Keygen license found for LS order ${orderId} (subscription ${subscriptionId})`
    );
  }
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.LS_SUBSCRIPTION_ID]: subscriptionId,
  });
}

async function renewLicenseForSubscription(
  subscriptionId: string,
  invoiceId: string
): Promise<void> {
  const license = await findLicenseByMetadata(
    LICENSE_METADATA_KEY.LS_SUBSCRIPTION_ID,
    subscriptionId
  );
  if (!license) {
    throw new Error(
      `No Keygen license found for LS subscription ${subscriptionId} (invoice ${invoiceId})`
    );
  }
  if (
    license.attributes.metadata[
      LICENSE_METADATA_KEY.LAST_RENEWED_INVOICE_ID
    ] === invoiceId
  ) {
    return; // retried webhook for a renewal invoice we already applied
  }
  const res = await keygenFetch(`/licenses/${license.id}/actions/renew`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(
      `Keygen license renew failed: ${res.status} ${await res.text()}`
    );
  }
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.LAST_RENEWED_INVOICE_ID]: invoiceId,
  });
}

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  replyTo?: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      subject,
      html,
      ...(replyTo && { reply_to: replyTo }),
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

async function sendLicenseEmail(
  email: string,
  name: string,
  licenseKey: string
): Promise<void> {
  await sendEmail(
    email,
    "Your ctrlyoke license key",
    `<p>Hi ${name || "there"},</p>
<p>Thanks for purchasing ctrlyoke! Your license key is:</p>
<p style="font-size:1.2em;font-weight:bold;">${licenseKey}</p>
<p>Activate it with the <strong>ctrlyoke: Activate Pro License</strong> command in VS Code
(or <strong>ctrlyoke: Activate Offline (Air-Gapped) License</strong> if this machine has no network access).</p>
<p>Need help? Reply to this email or reach out to support@ctrlyoke.dev.</p>`
  );
}

async function sendRefundEmail(email: string, name: string): Promise<void> {
  await sendEmail(
    email,
    "Your ctrlyoke refund has been processed",
    `<p>Hi ${name || "there"},</p>
<p>Your ctrlyoke refund has been processed. It can take up to 10 days to appear on your statement.</p>
<p>The license key from this purchase has been deactivated. ctrlyoke's free features keep working as before.</p>
<p>Questions about the refund? Reply to this email or reach out to ${BILLING_EMAIL}.</p>`,
    BILLING_EMAIL
  );
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (
    !secret ||
    !process.env.KEYGEN_ADMIN_TOKEN ||
    !process.env.RESEND_API_KEY
  ) {
    console.error("ls-webhook: missing required environment variables");
    return new Response("Server misconfigured", { status: 500 });
  }

  // Signature is computed over the raw body — must read text() before any JSON.parse.
  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get("x-signature"), secret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const eventName = (rawPayload as { meta?: { event_name?: string } }).meta
    ?.event_name;

  try {
    switch (eventName) {
      case LS_EVENT.ORDER_CREATED: {
        const payload = rawPayload as LemonSqueezyOrderPayload;
        const orderId = payload.data.id;
        const {
          user_email: email,
          user_name: name,
          status,
          first_order_item: { variant_id: variantId },
        } = payload.data.attributes;
        // Defensive: order_created is documented as "successfully placed", but don't
        // mint a license off a payload whose own status disagrees.
        if (status !== "paid") {
          return new Response("Ignored (not paid)", { status: 200 });
        }
        const policyId = KEYGEN_POLICY_BY_LS_VARIANT[variantId];
        if (!policyId) {
          throw new Error(
            `Unrecognized LS variant_id ${variantId} on order ${orderId} — no Keygen policy mapped in KEYGEN_POLICY_BY_LS_VARIANT`
          );
        }
        let license = await findLicenseByMetadata(
          LICENSE_METADATA_KEY.LS_ORDER_ID,
          orderId
        );
        if (!license) {
          license = await createLicense(policyId, orderId, email, name);
          await sendLicenseEmail(email, name, license.attributes.key);
        }
        return new Response("OK", { status: 200 });
      }
      case LS_EVENT.ORDER_REFUNDED: {
        // Fires for full *and* partial refunds; only a full refund revokes.
        const payload = rawPayload as LemonSqueezyOrderPayload;
        if (!payload.data.attributes.refunded) {
          return new Response("Ignored (partial refund)", { status: 200 });
        }
        await revokeRefundedLicense(
          LICENSE_METADATA_KEY.LS_ORDER_ID,
          payload.data.id,
          payload.data.id
        );
        return new Response("OK", { status: 200 });
      }
      case LS_EVENT.SUBSCRIPTION_CREATED: {
        const payload = rawPayload as LemonSqueezySubscriptionPayload;
        const { order_id: orderId } = payload.data.attributes;
        await linkSubscriptionToLicense(String(orderId), payload.data.id);
        return new Response("OK", { status: 200 });
      }
      case LS_EVENT.SUBSCRIPTION_PAYMENT_SUCCESS: {
        const payload = rawPayload as LemonSqueezySubscriptionInvoicePayload;
        const {
          subscription_id: subscriptionId,
          billing_reason: billingReason,
          status,
        } = payload.data.attributes;
        if (status !== "paid") {
          return new Response("Ignored (not paid)", { status: 200 });
        }
        if (billingReason !== LS_BILLING_REASON.RENEWAL) {
          // "initial" -> order_created already created the license with its
          // policy's own creation-based expiry. "updated" -> a plan-change
          // proration, not a renewal cycle. Neither should extend expiry.
          return new Response("Ignored (not a renewal)", { status: 200 });
        }
        await renewLicenseForSubscription(
          String(subscriptionId),
          payload.data.id
        );
        return new Response("OK", { status: 200 });
      }
      case LS_EVENT.SUBSCRIPTION_PAYMENT_REFUNDED: {
        const payload = rawPayload as LemonSqueezySubscriptionInvoicePayload;
        const {
          subscription_id: subscriptionId,
          billing_reason: billingReason,
          refunded,
        } = payload.data.attributes;
        if (!refunded) {
          return new Response("Ignored (partial refund)", { status: 200 });
        }
        if (billingReason === LS_BILLING_REASON.UPDATED) {
          // Refunding a plan-change proration doesn't undo the paid term.
          return new Response("Ignored (proration refund)", { status: 200 });
        }
        // An initial-invoice refund may also arrive as order_refunded; the
        // suspend and email are idempotent, so handling both is harmless.
        await revokeRefundedLicense(
          LICENSE_METADATA_KEY.LS_SUBSCRIPTION_ID,
          String(subscriptionId),
          payload.data.id
        );
        return new Response("OK", { status: 200 });
      }
      case LS_EVENT.SUBSCRIPTION_CANCELLED:
      case LS_EVENT.SUBSCRIPTION_EXPIRED:
        // Deliberate no-op: every subscription Keygen policy uses Restrict Access
        // expiration, so the license already locks itself out at term end — see
        // RELEASE_CHECKLIST.md §4.4 item 3.
        return new Response("Ignored (handled by policy expiration)", {
          status: 200,
        });
      default:
        // Unsubscribed/unrecognized event — acknowledge so LS stops retrying.
        return new Response("Ignored", { status: 200 });
    }
  } catch (err) {
    console.error("ls-webhook error:", err);
    return new Response("Internal Error", { status: 500 });
  }
};
