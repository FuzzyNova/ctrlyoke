// Glue between Lemon Squeezy (checkout/MoR) and Keygen (licensing) — see
// dev/implemented/PRO_LICENSE_PLAN.md §1.1-1.2 for the architecture this implements.
//
// order_created -> create a Keygen Pro license (idempotent on the LS order id), email the key.
// order_refunded -> suspend the Keygen license issued for that order.
//
// Required env vars (Netlify site settings, never committed):
//   LEMONSQUEEZY_WEBHOOK_SECRET  - HMAC secret set when the LS webhook was created
//   KEYGEN_ADMIN_TOKEN           - "fuzzynova-admin" Keygen admin token (see RELEASE_CHECKLIST.md 4.2)
//   RESEND_API_KEY               - Resend API key for sending the license-delivery email
import * as crypto from "node:crypto";

// Not secret — Keygen account/policy ids are stable identifiers, not credentials.
// See RELEASE_CHECKLIST.md §4.1 for where these come from.
const KEYGEN_ACCOUNT_ID = "6ed6209c-6633-4444-9d43-ab4a473e2f28";
const KEYGEN_PRO_POLICY_ID = "da0764ce-6577-419a-862d-128efdbfc329";
const KEYGEN_API_BASE = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;

const RESEND_FROM = "ctrlyoke <licensing@ctrlyoke.dev>";

const LS_EVENT = {
  ORDER_CREATED: "order_created",
  ORDER_REFUNDED: "order_refunded",
} as const;

// Keys into the Keygen license's `metadata` bag — single-sourced so the
// create path and the lookup path can never drift out of sync.
const LICENSE_METADATA_KEY = {
  LS_ORDER_ID: "lsOrderId",
  BUYER_EMAIL: "buyerEmail",
  BUYER_NAME: "buyerName",
} as const;

interface LemonSqueezyOrderPayload {
  meta: { event_name: string };
  data: {
    id: string;
    attributes: {
      user_email: string;
      user_name: string;
      status: string;
    };
  };
}

interface KeygenLicense {
  id: string;
  attributes: { key: string };
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

/** Idempotency check: has this LS order already minted a Keygen license? */
async function findLicenseByOrderId(
  orderId: string
): Promise<KeygenLicense | null> {
  const query = `metadata[${LICENSE_METADATA_KEY.LS_ORDER_ID}]=${encodeURIComponent(orderId)}`;
  const res = await keygenFetch(`/licenses?${query}`);
  if (!res.ok) {
    throw new Error(
      `Keygen license lookup failed: ${res.status} ${await res.text()}`
    );
  }
  const body = (await res.json()) as { data: KeygenLicense[] };
  return body.data[0] ?? null;
}

async function createLicense(
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
          policy: { data: { type: "policies", id: KEYGEN_PRO_POLICY_ID } },
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

async function suspendLicensesForOrder(orderId: string): Promise<void> {
  const license = await findLicenseByOrderId(orderId);
  if (!license) return; // refund for an order that never issued a license — nothing to do
  const res = await keygenFetch(`/licenses/${license.id}/actions/suspend`, {
    method: "POST",
  });
  // 400 == already suspended (a retried refund webhook); anything else is a real failure.
  if (!res.ok && res.status !== 400) {
    throw new Error(
      `Keygen license suspend failed: ${res.status} ${await res.text()}`
    );
  }
}

async function sendLicenseEmail(
  email: string,
  name: string,
  licenseKey: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: email,
      subject: "Your ctrlyoke Pro license key",
      html: `<p>Hi ${name || "there"},</p>
<p>Thanks for purchasing ctrlyoke Pro! Your license key is:</p>
<p style="font-size:1.2em;font-weight:bold;">${licenseKey}</p>
<p>Activate it with the <strong>ctrlyoke: Activate Pro License</strong> command in VS Code
(or <strong>ctrlyoke: Activate Offline (Air-Gapped) License</strong> if this machine has no network access).</p>
<p>Need help? Reply to this email or reach out to support@ctrlyoke.dev.</p>`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
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

  let payload: LemonSqueezyOrderPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const orderId = payload.data?.id;
  if (!orderId) {
    return new Response("Missing order id", { status: 400 });
  }

  try {
    switch (payload.meta?.event_name) {
      case LS_EVENT.ORDER_CREATED: {
        const {
          user_email: email,
          user_name: name,
          status,
        } = payload.data.attributes;
        // Defensive: order_created is documented as "successfully placed", but don't
        // mint a license off a payload whose own status disagrees.
        if (status !== "paid") {
          return new Response("Ignored (not paid)", { status: 200 });
        }
        let license = await findLicenseByOrderId(orderId);
        if (!license) {
          license = await createLicense(orderId, email, name);
          await sendLicenseEmail(email, name, license.attributes.key);
        }
        return new Response("OK", { status: 200 });
      }
      case LS_EVENT.ORDER_REFUNDED: {
        await suspendLicensesForOrder(orderId);
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
