// Inbound Keygen webhook: machine-count abuse detection for floating, large-cap
// licenses (the Enterprise site license). See RELEASE_CHECKLIST.md §4.4 item 4
// and PRO_LICENSE_PLAN.md §1.7.1 "Abuse detection & response".
//
// machine.created -> read the license's live machine count and email support@
//                    when it reaches the next milestone. There are two kinds:
//                    - fit check (50, 250, 1,000 machines): a count alone
//                      can't tell a large company from a small one reselling
//                      its key, so a person checks whether the count fits the
//                      buyer's size, and how fast it got there.
//                    - capacity (80% and 95% of the cap): a legitimate customer
//                      is about to be blocked; offer to raise the cap before
//                      they hit it (ENTERPRISE_TERMS.md §3(b)).
//                    This is detection only: the response stays the manual
//                    Keygen-dashboard suspend/reissue or cap raise. Pro licenses
//                    are skipped because Keygen already enforces their strict cap.
//
// The highest milestone alerted is stored on the license
// (`machineAlertMilestone`), so each milestone alerts once. A replayed or retried
// event re-reads the live count and cannot alert twice. Two machines created at
// the same moment can, at worst, send a duplicate alert.
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

const MACHINE_ALERT_KIND = {
  FIT_CHECK: "fit-check",
  CAPACITY: "capacity",
} as const;
type MachineAlertKind =
  (typeof MACHINE_ALERT_KIND)[keyof typeof MACHINE_ALERT_KIND];

/**
 * Absolute machine counts worth a "does this fit the company?" look. Enterprise
 * costs about 76 Pro seats, so a reseller only profits in the low hundreds.
 */
const FIT_CHECK_MILESTONES = [50, 250, 1000] as const;

/** Fractions of the machine cap at which a legitimate customer needs more room. */
const CAPACITY_MILESTONE_FRACTIONS = [0.8, 0.95] as const;

interface MachineMilestone {
  at: number;
  kind: MachineAlertKind;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * The license's milestones in ascending order. Fit checks at or above the first
 * capacity milestone are dropped, since the capacity alert covers them.
 */
function machineMilestones(license: KeygenLicense): MachineMilestone[] {
  const { maxMachines } = license.attributes;
  const capacity: MachineMilestone[] =
    maxMachines === null
      ? []
      : [
          ...new Set(
            CAPACITY_MILESTONE_FRACTIONS.map((fraction) =>
              Math.max(1, Math.ceil(maxMachines * fraction))
            )
          ),
        ].map((at) => ({ at, kind: MACHINE_ALERT_KIND.CAPACITY }));
  const firstCapacity = capacity[0]?.at ?? Infinity;
  const fitChecks: MachineMilestone[] = FIT_CHECK_MILESTONES.filter(
    (at) => at < firstCapacity
  ).map((at) => ({ at, kind: MACHINE_ALERT_KIND.FIT_CHECK }));
  return [...fitChecks, ...capacity];
}

/** "3 days" / "5 months" since the license was issued. */
function ageSince(iso: string, now: number): string {
  const days = Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));
  if (days < 60) return `${days} ${days === 1 ? "day" : "days"}`;
  return `${Math.floor(days / 30)} months`;
}

async function sendMachineCountAlert(
  license: KeygenLicense,
  machineCount: number,
  milestone: MachineMilestone
): Promise<void> {
  const { maxMachines, created } = license.attributes;
  const policyId = license.relationships.policy.data?.id;
  const policyName =
    policyId === KEYGEN_ENTERPRISE_POLICY_ID
      ? "ctrlyoke Enterprise"
      : `policy ${policyId ?? "unknown"}`;
  const buyerEmail =
    metadataString(license, LICENSE_METADATA_KEY.BUYER_EMAIL) ?? "unknown";
  const buyerName =
    metadataString(license, LICENSE_METADATA_KEY.BUYER_NAME) ?? "unknown";
  const orderId =
    metadataString(license, LICENSE_METADATA_KEY.LS_ORDER_ID) ?? "none";
  const cap = maxMachines === null ? "no cap" : `cap ${maxMachines}`;
  const age = ageSince(created, Date.now());
  const issued = created.slice(0, 10);
  const details = `<p>Keygen license <strong>${escapeHtml(license.id)}</strong> (${escapeHtml(policyName)}) has
<strong>${machineCount}</strong> activated machines (${cap}), ${age} after it was issued on ${issued}.</p>
<p>Buyer: ${escapeHtml(buyerName)} &lt;${escapeHtml(buyerEmail)}&gt;<br>
Lemon Squeezy order: ${escapeHtml(orderId)} (it holds the company's legal name and address)</p>`;
  if (milestone.kind === MACHINE_ALERT_KIND.CAPACITY) {
    await sendEmail(
      SUPPORT_EMAIL,
      `[ctrlyoke capacity] ${buyerName}'s license is at ${machineCount} of ${maxMachines} machines`,
      `${details}
<p>This customer is close to its machine cap, and activation stops working at the cap. Email the
buyer and offer to raise the cap (ENTERPRISE_TERMS.md §3(b)), then raise it on the license in the
Keygen dashboard. Some of these machines may no longer be in use: Keygen keeps every activation until
it is deactivated.</p>`
    );
    return;
  }
  await sendEmail(
    SUPPORT_EMAIL,
    `[ctrlyoke fit check] ${buyerName}'s license reached ${machineCount} machines in ${age}`,
    `${details}
<p>Does this count fit the company? Look it up from the order (website, LinkedIn headcount). A large
company growing fast is expected; a small one with hundreds of machines, especially soon after
purchase, may be reselling or leaking the key.</p>
<p>If it doesn't fit, review the machines in the Keygen dashboard (names, platforms, creation dates)
and email the customer before acting. If abuse is confirmed, suspend the license and reissue a fresh
key. Nothing has been blocked. See RELEASE_CHECKLIST.md §4.4 item 4.</p>`
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
  // A jump past several milestones at once sends one alert, for the highest.
  const reached = machineMilestones(license)
    .filter((milestone) => milestone.at <= machineCount)
    .at(-1);
  const alerted =
    license.attributes.metadata[LICENSE_METADATA_KEY.MACHINE_ALERT_MILESTONE];
  const alertedAt = typeof alerted === "number" ? alerted : 0;
  if (!reached || reached.at <= alertedAt) return "OK (no new milestone)";
  // Email first, then record: a failed record re-sends on retry (harmless),
  // whereas recording first and failing to send would lose the alert.
  await sendMachineCountAlert(license, machineCount, reached);
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.MACHINE_ALERT_MILESTONE]: reached.at,
  });
  return `OK (${reached.kind} alert sent)`;
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
