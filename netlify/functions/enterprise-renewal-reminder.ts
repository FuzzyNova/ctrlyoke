// Daily scheduled function: emails each Enterprise billing contact a renewal
// reminder ENTERPRISE_RENEWAL_NOTICE_DAYS before their subscription renews.
// ENTERPRISE_TERMS.md §4(b) promises at least 30 days' notice; Lemon Squeezy's
// own renewal email only goes out about 7 days ahead, so this covers the gap.
//
// The subscription state it reads (status, renews_at) is written onto each
// Keygen license by ls-webhook's subscription_* handlers. A subscription that is
// cancelled, paused, or otherwise not "active" will not renew, so it gets no
// reminder. `renewalNoticeSentFor` on the license makes the send idempotent per
// renewal date, so a re-run (or a missed day) never double-sends.
//
// Required env vars: KEYGEN_ADMIN_TOKEN, RESEND_API_KEY (see ls-webhook.ts).
import { KEYGEN_ENTERPRISE_POLICY_ID } from "../../src/license/KeygenConstants";
import {
  ENTERPRISE_RENEWAL_NOTICE_DAYS,
  LS_CUSTOMER_PORTAL_URL,
} from "../../src/license/LemonSqueezyConstants";
import { BILLING_EMAIL, escapeHtml, sendEmail } from "../lib/email";
import {
  KEYGEN_INACTIVE_LICENSE_STATUSES,
  LICENSE_METADATA_KEY,
  listLicensesForPolicy,
  metadataString,
  updateLicenseMetadata,
  type KeygenLicense,
} from "../lib/keygen";

export const config = { schedule: "0 15 * * *" };

const DAY_MS = 24 * 60 * 60 * 1000;

/** LS subscription status of a subscription that will charge on its renewal date. */
const LS_SUBSCRIPTION_STATUS_ACTIVE = "active";

/**
 * Two days of slack past the promised notice window, so a skipped or failed
 * daily run still sends the reminder (slightly early) instead of missing it.
 */
const REMINDER_WINDOW_MS = (ENTERPRISE_RENEWAL_NOTICE_DAYS + 2) * DAY_MS;

/** The renewal date (ISO) a license is due a reminder for, or null if none is due. */
function dueRenewalDate(license: KeygenLicense, now: number): string | null {
  const { status, suspended, expiry } = license.attributes;
  if (suspended || KEYGEN_INACTIVE_LICENSE_STATUSES.has(status)) return null;
  // Only subscription-backed licenses renew; a hand-issued license has no LS subscription.
  if (!metadataString(license, LICENSE_METADATA_KEY.LS_SUBSCRIPTION_ID)) {
    return null;
  }
  const subscriptionStatus = metadataString(
    license,
    LICENSE_METADATA_KEY.LS_SUBSCRIPTION_STATUS
  );
  if (subscriptionStatus !== LS_SUBSCRIPTION_STATUS_ACTIVE) return null;
  // LS's renews_at is the actual charge date; the Keygen expiry tracks it and is
  // the fallback for a license whose renewal date hasn't been recorded yet.
  const renewsAt =
    metadataString(license, LICENSE_METADATA_KEY.LS_SUBSCRIPTION_RENEWS_AT) ??
    expiry;
  if (!renewsAt) return null;
  const msUntilRenewal = Date.parse(renewsAt) - now;
  if (!(msUntilRenewal > 0 && msUntilRenewal <= REMINDER_WINDOW_MS)) {
    return null;
  }
  const renewalDate = new Date(renewsAt).toISOString().slice(0, 10);
  return metadataString(
    license,
    LICENSE_METADATA_KEY.RENEWAL_NOTICE_SENT_FOR
  ) === renewalDate
    ? null
    : renewalDate;
}

async function sendRenewalReminder(
  license: KeygenLicense,
  renewalDate: string
): Promise<void> {
  const email = metadataString(license, LICENSE_METADATA_KEY.BUYER_EMAIL);
  if (!email) {
    throw new Error(`Enterprise license ${license.id} has no buyer email`);
  }
  const name = metadataString(license, LICENSE_METADATA_KEY.BUYER_NAME) ?? "";
  const displayDate = new Date(`${renewalDate}T00:00:00Z`).toLocaleDateString(
    "en-US",
    { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }
  );
  await sendEmail(
    email,
    `Your ctrlyoke Enterprise subscription renews on ${displayDate}`,
    `<p>Hi ${escapeHtml(name) || "there"},</p>
<p>This is your advance notice that your ctrlyoke Enterprise subscription renews automatically on
<strong>${displayDate}</strong> for another year. The payment method on file will be charged your
subscription's current price, which is shown in the customer portal.</p>
<p>To update your billing details or payment method, or to cancel before the renewal date, use the
customer portal at <a href="${LS_CUSTOMER_PORTAL_URL}">${LS_CUSTOMER_PORTAL_URL}</a> and sign in with
this email address, or email ${BILLING_EMAIL} at least 48 hours before the renewal date. If you cancel,
your license keeps working until the end of the current term.</p>
<p>Questions about your subscription? Reply to this email or reach out to ${BILLING_EMAIL}.</p>`,
    BILLING_EMAIL
  );
  await updateLicenseMetadata(license, {
    [LICENSE_METADATA_KEY.RENEWAL_NOTICE_SENT_FOR]: renewalDate,
  });
}

export default async (): Promise<Response> => {
  if (!process.env.KEYGEN_ADMIN_TOKEN || !process.env.RESEND_API_KEY) {
    console.error(
      "enterprise-renewal-reminder: missing required environment variables"
    );
    return new Response("Server misconfigured", { status: 500 });
  }
  const now = Date.now();
  const licenses = await listLicensesForPolicy(KEYGEN_ENTERPRISE_POLICY_ID);
  let sent = 0;
  let failed = 0;
  // One failing license must not block reminders for the others.
  for (const license of licenses) {
    const renewalDate = dueRenewalDate(license, now);
    if (!renewalDate) continue;
    try {
      await sendRenewalReminder(license, renewalDate);
      sent++;
    } catch (err) {
      failed++;
      console.error(
        `enterprise-renewal-reminder: license ${license.id} failed:`,
        err
      );
    }
  }
  console.log(
    `enterprise-renewal-reminder: ${licenses.length} licenses checked, ${sent} reminders sent, ${failed} failed`
  );
  return new Response(`sent ${sent}, failed ${failed}`, {
    status: failed > 0 ? 500 : 200,
  });
};
