// Inbound Keygen webhook: machine-count abuse detection for floating, large-cap
// licenses (the Enterprise site license). See RELEASE_CHECKLIST.md §4.4 item 4
// and PRO_LICENSE_PLAN.md §1.7.1 "Abuse detection & response".
//
// machine.created -> read the license's live machine count and email
//                    support@ each time it crosses another
//                    MACHINE_ALERT_STEP_FRACTION of its machine cap. This is
//                    detection only: the response stays the manual Keygen-dashboard
//                    suspend/reissue. Pro licenses are skipped because Keygen
//                    already hard-enforces their small strict cap.
//
// The alert level reached is stored on the license (`machineAlertLevel`), so each
// threshold alerts once. A replayed or retried event re-reads the live count and
// cannot alert twice. Two machines created at the same moment can, at worst,
// send a duplicate alert.
//
// Requests are signed by Keygen with the account's Ed25519 key over
// `(request-target) host date digest` (https://keygen.sh/docs/api/signatures/).
//
// Required env vars: KEYGEN_ADMIN_TOKEN, RESEND_API_KEY (see ls-webhook.ts).
import * as crypto from "node:crypto";
import {
  KEYGEN_ACCOUNT_ID,
  KEYGEN_ACCOUNT_PUBLIC_KEY_HEX,
  KEYGEN_ENTERPRISE_POLICY_ID,
  KEYGEN_PRO_POLICY_ID,
} from "../../src/license/KeygenConstants";
import { SUPPORT_EMAIL, escapeHtml, sendEmail } from "../lib/email";
import {
  LICENSE_METADATA_KEY,
  getLicense,
  metadataString,
  updateLicenseMetadata,
  type KeygenLicense,
} from "../lib/keygen";

const KEYGEN_EVENT = {
  MACHINE_CREATED: "machine.created",
} as const;

const KEYGEN_SIGNATURE_ALGORITHM = "ed25519";

/** Alert at every 10% of the license's machine cap (300, 600, … for Enterprise's 3,000). */
const MACHINE_ALERT_STEP_FRACTION = 0.1;

/** Alert step for a license with no machine cap at all. */
const UNCAPPED_MACHINE_ALERT_STEP = 300;

interface KeygenWebhookEvent {
  data: {
    attributes: {
      event: string;
      /** The event's resource as a serialized JSON:API document. */
      payload: string;
    };
  };
}

interface KeygenMachinePayload {
  data: {
    id: string;
    relationships: { license: { data: { id: string } | null } };
  };
}

const KEYGEN_PUBLIC_KEY = crypto.createPublicKey({
  key: {
    kty: "OKP",
    crv: "Ed25519",
    x: Buffer.from(KEYGEN_ACCOUNT_PUBLIC_KEY_HEX, "hex").toString("base64url"),
  },
  format: "jwk",
});

/** Parses `keyid="…", algorithm="…", signature="…", headers="…"`. */
function parseSignatureHeader(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [, name, value] of header.matchAll(/(\w+)="([^"]*)"/g)) {
    params[name] = value;
  }
  return params;
}

function verifySignature(req: Request, rawBody: string): boolean {
  const header = req.headers.get("keygen-signature");
  const date = req.headers.get("date");
  if (!header || !date) return false;
  const params = parseSignatureHeader(header);
  if (
    params.keyid !== KEYGEN_ACCOUNT_ID ||
    params.algorithm !== KEYGEN_SIGNATURE_ALGORITHM ||
    !params.signature
  ) {
    return false;
  }
  // The digest is recomputed from the body we actually received; trusting
  // Keygen's Digest header instead would let a tampered body through.
  const digest = `sha-256=${crypto.createHash("sha256").update(rawBody).digest("base64")}`;
  const url = new URL(req.url);
  const signingData = [
    `(request-target): ${req.method.toLowerCase()} ${url.pathname}${url.search}`,
    `host: ${url.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join("\n");
  return crypto.verify(
    null,
    Buffer.from(signingData),
    KEYGEN_PUBLIC_KEY,
    Buffer.from(params.signature, "base64")
  );
}

/** How many machines make up one alert level for this license. */
function machineAlertStep(license: KeygenLicense): number {
  const { maxMachines } = license.attributes;
  if (maxMachines === null) return UNCAPPED_MACHINE_ALERT_STEP;
  return Math.max(1, Math.ceil(maxMachines * MACHINE_ALERT_STEP_FRACTION));
}

async function sendMachineCountAlert(
  license: KeygenLicense,
  machineCount: number
): Promise<void> {
  const { maxMachines } = license.attributes;
  const policyId = license.relationships.policy.data?.id;
  const policyName =
    policyId === KEYGEN_ENTERPRISE_POLICY_ID
      ? "ctrlyoke Enterprise"
      : `policy ${policyId ?? "unknown"}`;
  const buyerEmail =
    metadataString(license, LICENSE_METADATA_KEY.BUYER_EMAIL) ?? "unknown";
  const buyerName =
    metadataString(license, LICENSE_METADATA_KEY.BUYER_NAME) ?? "unknown";
  const cap = maxMachines === null ? "no cap" : `cap ${maxMachines}`;
  await sendEmail(
    SUPPORT_EMAIL,
    `[ctrlyoke alert] License ${license.id} has ${machineCount} activated machines`,
    `<p>Keygen license <strong>${escapeHtml(license.id)}</strong> (${escapeHtml(policyName)}) now has
<strong>${machineCount}</strong> activated machines (${cap}).</p>
<p>Buyer: ${escapeHtml(buyerName)} &lt;${escapeHtml(buyerEmail)}&gt;</p>
<p>This is an early warning, not an enforcement action: nothing has been blocked. If the count does not
fit the customer's size, inspect the machines in the Keygen dashboard, and if the key has leaked,
suspend the license and reissue a fresh key to the customer. See RELEASE_CHECKLIST.md §4.4 item 4.</p>`
  );
}

async function handleMachineCreated(
  machine: KeygenMachinePayload
): Promise<string> {
  const licenseId = machine.data.relationships.license.data?.id;
  if (!licenseId) return "Ignored (machine has no license)";
  const license = await getLicense(licenseId);
  if (license.relationships.policy.data?.id === KEYGEN_PRO_POLICY_ID) {
    return "Ignored (Pro cap is enforced by Keygen)";
  }
  const machineCount = license.relationships.machines.meta?.count ?? 0;
  const level = Math.floor(machineCount / machineAlertStep(license));
  const alerted =
    license.attributes.metadata[LICENSE_METADATA_KEY.MACHINE_ALERT_LEVEL];
  const alertedLevel = typeof alerted === "number" ? alerted : 0;
  if (level <= alertedLevel) return "OK (below next alert level)";
  // Email first, then record: a failed record re-sends on retry (harmless),
  // whereas recording first and failing to send would lose the alert.
  await sendMachineCountAlert(license, machineCount);
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.MACHINE_ALERT_LEVEL]: level,
  });
  return "OK (alert sent)";
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!process.env.KEYGEN_ADMIN_TOKEN || !process.env.RESEND_API_KEY) {
    console.error("keygen-webhook: missing required environment variables");
    return new Response("Server misconfigured", { status: 500 });
  }

  // The digest is computed over the raw body, so read text() before any JSON.parse.
  const rawBody = await req.text();
  if (!verifySignature(req, rawBody)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: KeygenWebhookEvent;
  let resource: unknown;
  try {
    event = JSON.parse(rawBody) as KeygenWebhookEvent;
    resource = JSON.parse(event.data.attributes.payload);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    switch (event.data.attributes.event) {
      case KEYGEN_EVENT.MACHINE_CREATED: {
        const result = await handleMachineCreated(
          resource as KeygenMachinePayload
        );
        return new Response(result, { status: 200 });
      }
      default:
        return new Response("Ignored", { status: 200 });
    }
  } catch (err) {
    console.error("keygen-webhook error:", err);
    return new Response("Internal Error", { status: 500 });
  }
};
