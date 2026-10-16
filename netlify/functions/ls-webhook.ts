// Glue between Lemon Squeezy (checkout/MoR) and Keygen (licensing) — see
// dev/implemented/PRO_LICENSE_PLAN.md §1.1-1.2 for the architecture this implements.
//
// order_created -> create a Keygen license (idempotent on the LS order id), email
//                  the key. Routes to the Pro or Enterprise Keygen policy based on
//                  which LS product/variant was purchased (see KEYGEN_POLICY_BY_LS_VARIANT).
//                  An Enterprise order without the terms-acceptance custom data
//                  from ctrlyoke.dev/enterprise/checkout still gets its license
//                  (the buyer has paid), but sales@ is alerted to follow up.
// order_refunded -> on a full refund, suspend the Keygen license issued for that
//                  order and email the buyer a refund confirmation. Partial refunds (goodwill credits, tax-only refunds) are
//                  ignored — the buyer still holds a paid license.
// subscription_created / _updated / _cancelled / _resumed / _expired -> record the
//                  LS subscription id, status, and renewal date on the license
//                  created by order_created, so renewal events can find it and the
//                  enterprise-renewal-reminder function knows which subscriptions
//                  will actually renew. None of them suspend anything: every
//                  subscription policy uses Restrict Access expiration, so the
//                  license already locks itself out at term end.
// subscription_payment_success -> on a "renewal" invoice (not "initial"/"updated"),
//                  extend the license's expiry via Keygen's renew action.
// subscription_payment_refunded -> on a full refund of an "initial" or "renewal"
//                  invoice, suspend the subscription's license and email the
//                  buyer; otherwise a refunded
//                  renewal would leave the license extended for another year.
//
// Required env vars (Netlify site settings, never committed):
//   LEMONSQUEEZY_WEBHOOK_SECRET  - HMAC secret shared by the live and test LS webhooks
//   KEYGEN_ADMIN_TOKEN           - "fuzzynova-admin" Keygen admin token (see RELEASE_CHECKLIST.md 4.2)
//   RESEND_API_KEY               - Resend API key for sending the license-delivery email
import * as crypto from "node:crypto";
import {
  KEYGEN_ENTERPRISE_POLICY_ID,
  KEYGEN_PRO_POLICY_ID,
} from "../../src/license/KeygenConstants";
import {
  ENTERPRISE_CHECKOUT_REQUIRED_FIELDS,
  LS_PRODUCT,
  LS_VARIANT_IDS,
} from "../../src/license/LemonSqueezyConstants";
import {
  BILLING_EMAIL,
  SALES_EMAIL,
  SUPPORT_EMAIL,
  escapeHtml,
  sendEmail,
} from "../lib/email";
import {
  LICENSE_METADATA_KEY,
  findLicenseByMetadata,
  keygenFetch,
  metadataString,
  updateLicenseMetadata,
  type KeygenLicense,
} from "../lib/keygen";

const KEYGEN_POLICY_BY_PRODUCT = {
  [LS_PRODUCT.PRO]: KEYGEN_PRO_POLICY_ID,
  [LS_PRODUCT.ENTERPRISE]: KEYGEN_ENTERPRISE_POLICY_ID,
} as const;

// Single source of truth for "which LS purchase issues which Keygen license type".
// Route by variant_id rather than product_id: it's present directly on both the
// Order and Subscription webhook resources, and each product has exactly one
// variant. Both modes are mapped so test-mode purchases keep working after launch.
// The Enterprise policy's own 1-year duration (Expiration Basis: From Creation)
// is what gives an Enterprise license its 1yr initial expiry — no separate expiry
// needs to be passed at issuance here.
const KEYGEN_POLICY_BY_LS_VARIANT: Record<number, string> = Object.fromEntries(
  Object.values(LS_VARIANT_IDS).flatMap((variants) =>
    Object.entries(variants).map(([product, variantId]) => [
      variantId,
      KEYGEN_POLICY_BY_PRODUCT[
        product as keyof typeof KEYGEN_POLICY_BY_PRODUCT
      ],
    ])
  )
);

const LS_EVENT = {
  ORDER_CREATED: "order_created",
  ORDER_REFUNDED: "order_refunded",
  SUBSCRIPTION_CREATED: "subscription_created",
  SUBSCRIPTION_UPDATED: "subscription_updated",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  SUBSCRIPTION_RESUMED: "subscription_resumed",
  SUBSCRIPTION_EXPIRED: "subscription_expired",
  SUBSCRIPTION_PAYMENT_SUCCESS: "subscription_payment_success",
  SUBSCRIPTION_PAYMENT_REFUNDED: "subscription_payment_refunded",
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

interface LemonSqueezyMeta {
  event_name: string;
  test_mode?: boolean;
  /** Checkout custom data (`checkout[custom][...]`), echoed on order and subscription events. */
  custom_data?: Record<string, unknown>;
}

interface LemonSqueezyOrderPayload {
  meta: LemonSqueezyMeta;
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
  meta: LemonSqueezyMeta;
  data: {
    id: string;
    attributes: {
      order_id: number;
      product_id: number;
      variant_id: number;
      status: string;
      /** ISO-8601; null once the subscription will not renew. */
      renews_at: string | null;
      updated_at: string;
    };
  };
}

interface LemonSqueezySubscriptionInvoicePayload {
  meta: LemonSqueezyMeta;
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

/** The required Enterprise checkout fields missing (or blank) from an order's custom data. */
function missingEnterpriseAcceptanceFields(
  customData: Record<string, unknown> | undefined
): string[] {
  return ENTERPRISE_CHECKOUT_REQUIRED_FIELDS.filter((field) => {
    const value = customData?.[field];
    return typeof value !== "string" || !value.trim();
  });
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
  if (
    metadataString(license, LICENSE_METADATA_KEY.REFUND_NOTIFIED_ID) ===
    refundId
  ) {
    return;
  }
  const email = metadataString(license, LICENSE_METADATA_KEY.BUYER_EMAIL);
  if (email) {
    await sendRefundEmail(
      email,
      metadataString(license, LICENSE_METADATA_KEY.BUYER_NAME) ?? ""
    );
  }
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.REFUND_NOTIFIED_ID]: refundId,
  });
}

/**
 * Record a subscription's id, status, and renewal date on its license. LS sends
 * subscription events "alongside" order_created but doesn't guarantee ordering,
 * so if the license isn't there yet this throws and lets LS's webhook retry
 * catch it up — the same self-healing idempotency shape as the rest of this
 * file. Events can also arrive out of order relative to each other, so an event
 * older than the state already recorded is ignored.
 */
async function recordSubscriptionState(
  payload: LemonSqueezySubscriptionPayload
): Promise<void> {
  const subscriptionId = payload.data.id;
  const {
    order_id: orderId,
    status,
    renews_at: renewsAt,
    updated_at: updatedAt,
  } = payload.data.attributes;
  const license =
    (await findLicenseByMetadata(
      LICENSE_METADATA_KEY.LS_SUBSCRIPTION_ID,
      subscriptionId
    )) ??
    (await findLicenseByMetadata(
      LICENSE_METADATA_KEY.LS_ORDER_ID,
      String(orderId)
    ));
  if (!license) {
    throw new Error(
      `No Keygen license found for LS order ${orderId} (subscription ${subscriptionId})`
    );
  }
  const recordedAt = metadataString(
    license,
    LICENSE_METADATA_KEY.LS_SUBSCRIPTION_UPDATED_AT
  );
  if (recordedAt && Date.parse(recordedAt) > Date.parse(updatedAt)) {
    return; // a newer event already recorded this subscription's state
  }
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.LS_SUBSCRIPTION_ID]: subscriptionId,
    [LICENSE_METADATA_KEY.LS_SUBSCRIPTION_STATUS]: status,
    [LICENSE_METADATA_KEY.LS_SUBSCRIPTION_RENEWS_AT]: renewsAt ?? "",
    [LICENSE_METADATA_KEY.LS_SUBSCRIPTION_UPDATED_AT]: updatedAt,
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
    metadataString(license, LICENSE_METADATA_KEY.LAST_RENEWED_INVOICE_ID) ===
    invoiceId
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

async function sendLicenseEmail(
  email: string,
  name: string,
  licenseKey: string
): Promise<void> {
  await sendEmail(
    email,
    "Your ctrlyoke license key",
    `<p>Hi ${escapeHtml(name) || "there"},</p>
<p>Thanks for purchasing ctrlyoke! Your license key is:</p>
<p style="font-size:1.2em;font-weight:bold;">${escapeHtml(licenseKey)}</p>
<p>Activate it with the <strong>ctrlyoke: Activate Pro License</strong> command in VS Code
(or <strong>ctrlyoke: Activate Offline (Air-Gapped) License</strong> if this machine has no network access).</p>
<p>Need help? Reply to this email or reach out to ${SUPPORT_EMAIL}.</p>`
  );
}

async function sendRefundEmail(email: string, name: string): Promise<void> {
  await sendEmail(
    email,
    "Your ctrlyoke refund has been processed",
    `<p>Hi ${escapeHtml(name) || "there"},</p>
<p>Your ctrlyoke refund has been processed. It can take up to 10 days to appear on your statement.</p>
<p>The license key from this purchase has been deactivated. ctrlyoke's free features keep working as before.</p>
<p>Questions about the refund? Reply to this email or reach out to ${BILLING_EMAIL}.</p>`,
    BILLING_EMAIL
  );
}

/** Internal alert: an Enterprise order reached us without a complete terms-acceptance record. */
async function sendMissingAcceptanceAlert(
  orderId: string,
  buyerEmail: string,
  buyerName: string,
  missingFields: string[],
  testMode: boolean
): Promise<void> {
  await sendEmail(
    SALES_EMAIL,
    `${testMode ? "[TEST] " : ""}Enterprise order ${orderId} has no terms-acceptance record`,
    `<p>Lemon Squeezy order <strong>${escapeHtml(orderId)}</strong> bought ctrlyoke Enterprise without the
checkout data from ctrlyoke.dev/enterprise/checkout, so there is no record of the Enterprise Terms being
accepted on behalf of a named legal entity. The license was issued and emailed as usual.</p>
<p>Buyer: ${escapeHtml(buyerName)} &lt;${escapeHtml(buyerEmail)}&gt;<br>
Missing fields: ${missingFields.map(escapeHtml).join(", ")}</p>
<p>Follow up with the buyer to get the Enterprise Terms accepted (or a signed Order) and the legal
entity's name and business address. See RELEASE_CHECKLIST.md §4.4 item 5.</p>`,
    buyerEmail
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
          if (policyId === KEYGEN_ENTERPRISE_POLICY_ID) {
            const missing = missingEnterpriseAcceptanceFields(
              payload.meta.custom_data
            );
            // Sent before the license exists so a failed send is retried with
            // the whole event; a duplicate alert is harmless, a lost one is not.
            if (missing.length > 0) {
              await sendMissingAcceptanceAlert(
                orderId,
                email,
                name,
                missing,
                payload.meta.test_mode === true
              );
            }
          }
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
      case LS_EVENT.SUBSCRIPTION_CREATED:
      case LS_EVENT.SUBSCRIPTION_UPDATED:
      case LS_EVENT.SUBSCRIPTION_CANCELLED:
      case LS_EVENT.SUBSCRIPTION_RESUMED:
      case LS_EVENT.SUBSCRIPTION_EXPIRED: {
        // Records state only. Cancellation and expiry deliberately do not
        // suspend: Restrict Access expiration ends the license at term end —
        // see RELEASE_CHECKLIST.md §4.4 item 3.
        await recordSubscriptionState(
          rawPayload as LemonSqueezySubscriptionPayload
        );
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
      default:
        // Unsubscribed/unrecognized event — acknowledge so LS stops retrying.
        return new Response("Ignored", { status: 200 });
    }
  } catch (err) {
    console.error("ls-webhook error:", err);
    return new Response("Internal Error", { status: 500 });
  }
};
