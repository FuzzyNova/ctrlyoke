# Lemon Squeezy → Stripe Managed Payments migration

**Status:** Plan, not started. Written November 25, 2026 from the Lemon Squeezy migration docs
and the Stripe Managed Payments docs as of that date (sources at the end). Re-read both before
starting: the Lemon Squeezy migration tooling had not launched yet when this was written.

**Hard deadline:** **March 31, 2027.** On that date Lemon Squeezy stops processing every
transaction, including subscription renewals. Lemon Squeezy says it "won't be able to extend"
it.

## 1. What is happening

Lemon Squeezy (our checkout and merchant of record since launch) is shutting down. Its
replacement is **Stripe Managed Payments**, a merchant-of-record mode of Stripe Checkout and
Payment Links. The legal seller becomes **Sold through Link, LLC**, which is the renamed Lemon
Squeezy LLC.

| Date              | Event                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| November 16, 2026 | Lemon Squeezy closes new users and new store sign-ups (our store is unaffected).                 |
| December 2, 2026  | Migration tooling opens at `app.lemonsqueezy.com/migration` for eligible stores.                 |
| Mid-January 2027  | Lemon Squeezy's recommended latest date to _start_ migrating (it takes 4–8 weeks).               |
| March 31, 2027    | Lemon Squeezy stops all transactions and renewals, and dashboard access ends.                    |
| December 1, 2027  | Promotional Managed Payments fee (1.5%) ends. It starts when the migration toolkit is installed. |

**Fees.** Lemon Squeezy charges 5% + 50¢. Managed Payments charges 3.5% of the tax-inclusive
total, plus Stripe's normal processing fees and Stripe Billing fees on subscriptions. Until
December 1, 2027 the 3.5% drops to 1.5%. Installing the toolkit early (December 2026) gets the
longest promotional window.

## 2. What this means for ctrlyoke

### 2.1 Licensing is not affected

The migration docs warn that Managed Payments has no license-key system, and that customers
"may lose access to their license keys" after March 31, 2027. **This does not apply to us.**
Lemon Squeezy's "Generate license keys" is off on both products (`RELEASE_CHECKLIST.md` §5.1).
Every license is a **Keygen** license minted by our own webhook, and activation and validation
in the extension and CLI (`src/license/LicenseService.ts`) talk only to Keygen. Existing Pro
and Enterprise keys keep working through and after the shutdown, and **no extension, CLI or
VSIX change is required.**

### 2.2 What does have to move

Lemon Squeezy is only the checkout, the merchant of record, the customer billing portal, and the
event source for our Netlify glue. Everything that touches it:

| Area                        | Files                                                                                                                                                   | Lemon Squeezy dependency                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Webhook → Keygen glue       | `netlify/functions/ls-webhook.ts`                                                                                                                       | LS HMAC (`X-Signature`), LS event names and payloads, variant-id routing, `meta.custom_data`, `meta.test_mode` |
| Renewal reminder            | `netlify/functions/enterprise-renewal-reminder.ts`                                                                                                      | `lsSubscription*` metadata, LS status `"active"`, `LS_CUSTOMER_PORTAL_URL` in the email                        |
| Machine-count alert         | `netlify/functions/keygen-webhook.ts` (≈ line 183–190)                                                                                                  | Prints the `lsOrderId` and calls the LS order the holder of the legal name and address                         |
| Keygen metadata keys        | `netlify/lib/keygen.ts` (`LICENSE_METADATA_KEY`)                                                                                                        | `lsOrderId`, `lsSubscriptionId`, `lsSubscriptionStatus`, `lsSubscriptionRenewsAt`, `lsSubscriptionUpdatedAt`   |
| Test-mode guard             | `netlify/lib/test-mode-orders.ts` (+ `.test.mjs`, run by `test:packaging`)                                                                              | Takes LS `test_mode`                                                                                           |
| Shared constants            | `src/license/LemonSqueezyConstants.ts` (also listed in `knip.json`)                                                                                     | Store URL, portal URL, variant ids, checkout URLs. It also holds provider-neutral pieces (see §4.1)            |
| Landing checkout            | `landing/src/components/LemonCheckout.astro`, `landing/src/config.ts`, `landing/src/pages/pricing.astro`, `landing/src/pages/enterprise/checkout.astro` | Lemon.js overlay, `checkout[custom][…]` query params, LS checkout links                                        |
| Legal-version helper users  | `landing/src/pages/terms.astro`, `scripts/legal-archive.mjs`                                                                                            | Import `readLegalDocumentVersion` from `LemonSqueezyConstants.ts` (import path only)                           |
| Public copy                 | `docs/pro/index.md` (≈ line 80), pricing FAQ (`pricing.astro` ≈ line 81), Enterprise checkout copy                                                      | Names Lemon Squeezy as checkout and MoR                                                                        |
| Legal documents (versioned) | `PRIVACY.md` 1.8, `DPA.md` 1.0, `ENTERPRISE_TERMS.md` 1.1                                                                                               | Name Lemon Squeezy as MoR, as the portal, and as the webhook source (§6)                                       |
| Trust page                  | `TRUST_PAGE.md`                                                                                                                                         | Lists Lemon Squeezy as the payments provider                                                                   |
| Ops docs                    | `dev/active/RELEASE_CHECKLIST.md` Phase 5, `dev/backlog/CTRLYOKE_ACCOUNTS_PLAN.md` (≈ lines 225, 239)                                                   | Account inventory, webhook ids, secrets                                                                        |
| Brand assets                | `scripts/generate-app-icons.mjs` (`ls-logo.png`, `ls-favicon.png`)                                                                                      | LS store logo. Stripe needs its own icon and brand settings                                                    |

### 2.3 Our products and what Managed Payments changes for each

- **Pro — $59 one-time**, perpetual Keygen license, 30-day money-back guarantee.
  No ongoing billing, so existing Pro buyers need nothing. Only new sales move.
- **Enterprise — $4,499/year subscription**, 1-year Keygen policy, renewed by the webhook on each
  paid renewal invoice. **Existing Enterprise subscriptions must move to Stripe before their
  next renewal or before March 31, 2027, whichever comes first.** Otherwise the renewal never
  charges and the license expires at term end (Restrict Access expiration).

Managed Payments facts that shape the design:

- **Surfaces:** Payment Links and hosted Checkout Sessions (`managed_payments[enabled]=true`,
  API version `2025-03-31.basil` or later). Elements, PaymentIntents and Connect are **not**
  supported. Embedded Checkout is not clearly documented either way. Custom domains are not
  supported on checkout.
- **Removed Checkout params:** `automatic_tax`, `tax_id_collection`, `customer_update[name|address]`,
  `invoice_creation`, `payment_method_types`, statement descriptors, and others. Stripe
  calculates tax itself and requires a name and billing address.
- **Metadata:** Session `metadata` and `subscription_data.metadata` carry no Managed Payments
  restriction. Stripe's general limit is 50 keys, 40-char keys, and 500-char values.
  `custom_fields` and `consent_collection.terms_of_service` are undocumented under Managed
  Payments.
- **Customer self-service** happens at **link.com** (order history, cancellation, payment method,
  billing address), not a store portal. `subscription.default_payment_method` cannot be set
  through the API.
- **Refunds** can be issued by us (Dashboard or API) **and by Stripe on its own**: within 60
  days in some cases, or when we don't answer a Stripe request within 48 hours. The webhook has
  to observe refunds rather than assume we initiated them.
- **Renewal emails** come from Link. The 12-month anniversary notice goes out 15 days before by
  default, with a 7-day minimum. That falls short of the 30 days `ENTERPRISE_TERMS.md` §4(b)
  promises, so **`enterprise-renewal-reminder` stays.**
- **Receipts and statements** read "Sold through Link" and `LINK.COM* <descriptor>`.
  Receipt settings in our Dashboard do not affect them.
- **No PayPal.** PayPal subscriptions cannot migrate, and those customers must re-purchase.
  India-issued cards need re-authorization. Other card subscriptions migrate without customers
  re-entering details, and customers get at least 14 days' notice.
- **Account type:** Express and Connect accounts are ineligible. The Stripe Express account
  behind our Lemon Squeezy payouts **cannot** be reused. We need a standard Stripe account for
  Fuzzy Nova LLC (US is an eligible location), created through
  `dashboard.stripe.com/register/managed_payments` or through the migration tooling.
- **Product tax code:** each product needs one. Candidates are `txcd_10202003` (downloadable
  software, business use) and `txcd_10103001` (SaaS, business use). Confirm with the accountant:
  ctrlyoke is downloadable software, licensed per machine through Keygen.

## 3. Decisions

1. **Checkout Sessions created server-side, not Payment Links.** Both checkouts record the
   terms-acceptance data on the order, and for Enterprise that order _is_ the acceptance record
   (`ENTERPRISE_TERMS.md` §2, `PRIVACY.md` §3.3). Payment Links cannot carry per-purchase
   metadata, and a buyer can edit a query string. A new Netlify function creates the session,
   stamps the acceptance data into `metadata`, and returns `session.url`. That moves the
   acceptance record from a browser-supplied query string to data our server wrote, which is an
   improvement.
2. **Hosted redirect replaces the Lemon.js overlay.** Embedded Checkout is unconfirmed under
   Managed Payments, and an overlay is not worth a dependency on undocumented behavior.
   `success_url` points at `POST_PURCHASE_PATH`. Revisit embedded Checkout once Stripe documents
   it.
3. **No Stripe SDK.** Keep the current dependency-free shape: Node 22 `fetch` against the REST
   API, and `node:crypto` for webhook verification. Verification means HMAC-SHA256 of
   `${t}.${rawBody}`, compared in constant time against each `v1=` entry of `Stripe-Signature`,
   with a 5-minute timestamp tolerance. Pin `Stripe-Version` on every request so a Dashboard
   default change cannot alter payloads.
4. **New provider-neutral Keygen metadata, old keys stay readable.** Add `stripeCustomerId`,
   `stripeCheckoutSessionId`, `stripePaymentIntentId`, `stripeSubscriptionId`, and
   `subscriptionStatus`/`subscriptionRenewsAt`/`subscriptionUpdatedAt` (a neutral name, written
   by the Stripe path). Never rewrite or drop `ls*` keys on existing licenses, because they are
   the historical link to the Lemon Squeezy order. Every reader (the renewal reminder, the
   keygen-webhook alert) prefers the new keys and falls back to the old ones.
5. **Route by Stripe price id.** This mirrors today's variant-id routing. `checkout.session.completed`
   does not include line items, so fetch `/v1/checkout/sessions/{id}/line_items` and map
   `price.id` to the Keygen policy through a `STRIPE_PRICE_IDS` table (sandbox + live), the same
   way `KEYGEN_POLICY_BY_LS_VARIANT` is built today. This also covers purchases the
   migration tooling or a Dashboard Payment Link creates, which carry no metadata of ours.
6. **Run both webhooks in parallel until Lemon Squeezy is gone.** `ls-webhook` keeps handling
   Lemon Squeezy refunds and renewals until March 31, 2027, then is deleted (§7, step 9).

## 4. Implementation

### 4.1 Split the constants

- Move provider-neutral pieces out of `LemonSqueezyConstants.ts` into a new
  `src/license/CheckoutConstants.ts`: `ENTERPRISE_CHECKOUT_FIELD`, `CHECKOUT_TERMS_FIELD`,
  `ENTERPRISE_CHECKOUT_REQUIRED_FIELDS`, both acceptance-method strings,
  `ENTERPRISE_RENEWAL_NOTICE_DAYS`, and `readLegalDocumentVersion` (consider
  `src/license/LegalVersion.ts` for that last one, since it is not checkout-specific). Update
  `terms.astro`, `scripts/legal-archive.mjs`, the checkout pages, and `knip.json`.
- Add `src/license/StripeConstants.ts`: the pinned API version, `STRIPE_PRODUCT` (`pro`,
  `enterprise`), `STRIPE_PRICE_IDS: Record<"live" | "sandbox", Record<product, string>>`,
  and the customer self-service URL (link.com, or our own Stripe Customer Portal link if we
  configure one, see open question 3). None of these are credentials.
- `LemonSqueezyConstants.ts` shrinks to what `ls-webhook` still needs, and is deleted with it.

### 4.2 `netlify/functions/create-checkout.ts` (new)

`POST` with `{ product: "pro" | "enterprise", acceptance: {…} }`:

1. Validate the body. Require `product`. For Enterprise, require every
   `ENTERPRISE_CHECKOUT_REQUIRED_FIELDS` entry, non-blank, each ≤ 500 chars (the Stripe metadata
   limit). The form enforces the same limit client-side.
2. Overwrite `terms_accepted_at` with the server clock, and `terms_versions` with the versions
   the deployed site serves (`acceptedVersionsRecord`). The browser's copy of either is not
   trusted. Note: the function reads the legal archive at build time, so it must import from a
   module bundled into the function, not from `landing/`.
3. `POST /v1/checkout/sessions` with: `mode` (`payment` for Pro, `subscription` for Enterprise),
   `managed_payments[enabled]=true`, the price id, `metadata[…]` (acceptance fields + `product`),
   `subscription_data[metadata][…]` (same keys, so the subscription carries the record too),
   `success_url`, `cancel_url`, and `customer_email` if collected. For Enterprise only, include
   `consent_collection[terms_of_service]=required` _if_ the sandbox confirms it works (open
   question 2). Our own checkbox stays the primary acceptance either way.
4. Return `{ url }`. Rate-limit by IP (Netlify's built-in or a simple per-instance window) so the
   endpoint cannot be used to spam session creation.

Env: `STRIPE_SECRET_KEY` (restricted key: Checkout Sessions write, Prices read). Use a sandbox
key in preview deploys and `astro dev`, and the live key in production. This replaces the
`LS_CHECKOUT_MODE` switch in `landing/src/config.ts`.

### 4.3 `netlify/functions/stripe-webhook.ts` (new)

Extract the provider-agnostic license operations from `ls-webhook.ts` into
`netlify/lib/license-fulfillment.ts` first, so both webhooks call one implementation (DRY):
`issueLicense`, `revokeRefundedLicense`, `recordSubscriptionState`, `renewLicense`, the three
emails, and the missing-acceptance alert. Then `ls-webhook.ts` becomes a thin LS adapter, and
`stripe-webhook.ts` becomes a thin Stripe adapter.

| Stripe event                                              | Action                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`                              | If `payment_status === "paid"`, issue the license, idempotent on `stripeCheckoutSessionId`. Route by price id, alert sales@ on a missing Enterprise acceptance record, and store customer, payment intent and subscription ids.                                                                                                                                                                |
| `checkout.session.async_payment_succeeded`                | Same as above (delayed payment methods).                                                                                                                                                                                                                                                                                                                                                       |
| `customer.subscription.created` / `.updated` / `.deleted` | Record status and renewal date. Under API `basil`, `current_period_end` lives on the **subscription item**, not the subscription. Ignore events older than `subscriptionUpdatedAt`. Never suspend (Restrict Access expiration already handles term end).                                                                                                                                       |
| `invoice.paid`                                            | Only when `billing_reason === "subscription_cycle"`, renew the license, idempotent on the invoice id (`lastRenewedInvoiceId`, reused). Under `basil` the subscription id is at `invoice.parent.subscription_details.subscription`.                                                                                                                                                             |
| `charge.refunded`                                         | Only when the charge is fully refunded (`charge.refunded === true`), suspend the license and send the refund email. Resolve the license by `stripePaymentIntentId` (Pro and initial Enterprise). For a renewal charge, resolve payment intent → invoice payment → invoice → subscription → license. **Verify the exact lookup path in the sandbox.** Stripe-initiated refunds arrive here too. |
| `charge.dispute.created` (new)                            | Email billing@ with the license id. Don't auto-suspend: EULA §6(e) allows it, but a human decides. Lemon Squeezy gave us no dispute signal, so this is new coverage.                                                                                                                                                                                                                           |

Test-mode guard: replace the `test_mode` argument with `!event.livemode`, keep the
`ALLOW_TEST_MODE_ORDERS` opt-in, and rename the helper (e.g. `shouldIssueNonLiveLicense`) with its
test. Sandboxes and live have **separate webhook signing secrets**. Accept both
(`STRIPE_WEBHOOK_SECRET`, `STRIPE_SANDBOX_WEBHOOK_SECRET`), the same way the one LS secret
covers both LS modes today.

Env: `STRIPE_WEBHOOK_SECRET`, `STRIPE_SANDBOX_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` (read access
to sessions, line items, invoices and charges), plus the existing `KEYGEN_ADMIN_TOKEN` and
`RESEND_API_KEY`.

### 4.4 Renewal reminder and Keygen alert

- `enterprise-renewal-reminder.ts`: read the neutral `subscription*` keys first, then fall back to
  `ls*` keys. Treat Stripe `active` (and `trialing`, if ever used) as "will renew", and
  `cancel_at_period_end === true` as "will not renew". Record that as a status, because Stripe
  keeps `status: active` until the period ends. The email's portal link becomes the Stripe-side
  self-service URL. Its wording must match the new `ENTERPRISE_TERMS.md` text (§6).
- `keygen-webhook.ts`: print the Stripe checkout session or customer id when present, and
  update the "it holds the legal name and address" wording. Under Stripe, the legal name and
  address live in the Checkout Session metadata (Dashboard → payment → metadata).

### 4.5 Landing site

- Delete `LemonCheckout.astro`, plus `LEMON_JS_URL`, `LS_OVERLAY_CLASS`, `LS_OVERLAY_PARAMS`,
  `CHECKOUT_URL`, and `ENTERPRISE_LS_CHECKOUT_URL` from `config.ts`.
- Add one shared client helper (a small Astro component or module) that POSTs to
  `/.netlify/functions/create-checkout` and `location.assign`s the returned URL. Both
  `pricing.astro` and `enterprise/checkout.astro` use it. It shows an inline error on failure.
  The no-JavaScript fallback is a plain form POST to the same function, which then answers with
  a `303` redirect to the session URL.
- Copy: pricing FAQ ("Checkout is handled by Stripe, our merchant of record is Link…"), the
  Enterprise checkout bullets (≈ lines 46 and 134), `docs/pro/index.md`, and `TRUST_PAGE.md`.
  Mention that receipts and the card statement show **Link / LINK.COM**, so buyers don't
  dispute an unfamiliar charge.
- Gate the switch behind one flag (e.g. `CHECKOUT_PROVIDER` in `config.ts`). Then cutover is a
  single-line deploy, and rolling back to Lemon Squeezy stays possible until it shuts down.

### 4.6 Tests

- Unit tests (node `--test`, added to `test:packaging` beside `test-mode-orders.test.mjs`) for:
  - Stripe signature verification: valid, a tampered body, a stale timestamp, and multiple `v1`
    entries.
  - Price-id → policy routing.
  - The create-checkout body validation and server-side overwrite of the acceptance timestamp
    and versions.
  - Full vs. partial refund detection.
  - The neutral/`ls*` metadata fallback in the reminder's `dueRenewalDate`.
- Sandbox end to end (manual, recorded in the release checklist, as in LS Phase 5.3):
  - A Pro purchase gives exactly one license, a retried event gives no duplicate, and a full
    refund suspends it and sends the email.
  - An Enterprise purchase carries the acceptance metadata on the session and subscription, a
    missing-field purchase alerts sales@, and a test-clock-advanced renewal extends the expiry
    exactly once.
  - Cancellation records the status, and the reminder skips that license.
  - A dispute sends an alert.

## 5. Migrating existing Enterprise subscriptions

The Lemon Squeezy tooling migrates eligible card subscriptions and produces a report that maps
Lemon Squeezy customer ids to Stripe ids. The webhook finds a license by Stripe subscription id,
so **every migrated subscription's license needs `stripeSubscriptionId` (and the neutral status
and renewal keys) stamped onto it before its first Stripe renewal.** Otherwise `invoice.paid`
throws "No Keygen license found" and the renewal charges without extending the license.

- Write a one-off script, `scripts/backfill-stripe-subscription-ids.mjs`, that reads the
  tooling's mapping report. For each migrated subscription it finds the Keygen license by
  `lsSubscriptionId` and merges in the Stripe ids (`updateLicenseMetadata` already merges). Dry
  run by default, `--apply` to write. Run it once, and keep it in `scripts/` until the last
  migrated subscription has renewed once on Stripe.
- Belt and braces: in `invoice.paid` and `customer.subscription.*`, when no license matches the
  Stripe subscription id, fall back to the subscription's metadata or the tooling's own
  `lemon_squeezy_*` reference if one exists (check the report format). Failing that, throw so
  Stripe retries for up to 3 days, which leaves time to run the backfill.
- Before confirming in the Migration Hub, check for any Enterprise subscription paid by PayPal
  (it cannot migrate, so contact that customer to re-purchase) or by an India-issued card (it
  needs re-authorization).
- **Enterprise customer notice.** The DPA's 30-day prior-notice clause (§9) covers
  Sub-processors. Lemon Squeezy and Link are framed as independent MoR controllers, not
  Sub-processors, so it may not strictly apply. Even so, email each Enterprise billing contact
  at least 30 days before their subscription moves. Say what changes: the MoR name, the portal
  (link.com), the receipts, and the statement descriptor. Say what doesn't: the license, the
  price, and the renewal date. Stripe's own 14-day notice comes on top of ours.

## 6. Legal documents (counsel)

These are versioned documents, so follow "Releasing a new version" in `legal/README.md`. Draft
in `dev/active/`, get counsel's approval, then adopt in one commit. **Bundle this with
`dev/backlog/PRIVACY_1.9_THIRD_PARTY_REQUESTS.md`** so Privacy 1.9 goes through counsel once.

- **`PRIVACY.md` 1.8 → 1.9.** §(purchases) and the vendor table: Lemon Squeezy becomes Stripe
  (processor and platform) and Sold through Link, LLC / Link (MoR, customer account). The
  Netlify function paragraph: events now come from Stripe, and the function now _sends_
  purchaser data to Stripe (session creation), not only receives it.
- **`ENTERPRISE_TERMS.md` 1.1 → 1.2.** Rewrite every Lemon Squeezy reference in the preamble, §4,
  §5 and §6: "buyer terms" become Link's terms, the "Lemon Squeezy customer portal" becomes
  Link, the charge authorization names the new MoR, and refunds and dunning follow Link's
  process. Check the renewal-reminder sentence still holds ("Licensor or the merchant of record
  will send … at least thirty days" — our function guarantees it).
- **`DPA.md` 1.0 → 1.1.** §2 (MoR not a Sub-processor), Annex III clarifications, and Annex
  (security): "Lemon Squeezy webhook signatures" become Stripe signatures, "Lemon Squeezy
  webhook secrets" become Stripe webhook secrets and API keys. Ask counsel whether Stripe, as
  the API our server calls, is now a Sub-processor for Enterprise data. If so, add it to Annex
  II and give the 30-day notice.
- **`LICENSE.md` (EULA)** does not mention Lemon Squeezy. No change, unless counsel wants the
  refund language aligned with Stripe's ability to refund on its own.
- Counsel question: existing Enterprise customers accepted Enterprise Terms 1.0/1.1, which name
  Lemon Squeezy. Does moving their subscription to a new MoR need their consent, or is notice
  under the existing terms enough? The MoR is the same legal entity, renamed. The answer decides
  whether §5's email is a notice or a request.

Adopt the new versions **on cutover day** (§7, step 6), not before. The pages must describe the
checkout buyers actually see.

## 7. Sequence

The Pro refund window drives the ordering. A Lemon Squeezy order can be refunded only while
Lemon Squeezy is processing, so **new Pro sales must leave Lemon Squeezy by March 1, 2027.**
After that date every LS Pro order's 30-day guarantee expires before March 31.

1. **Now → December 2, 2026:** create the Stripe account for Fuzzy Nova LLC (standard, not
   Express), with MFA (passkey/TOTP, as for the other licensing vendors), the Mercury payout
   account, and brand settings. Ask the accountant to pick the tax code. Send the legal drafts
   to counsel (§6) now, because counsel review is the longest lead item.
2. **December 2+:** install the migration toolkit, which starts the 1.5% promotional rate. Let it
   build the Stripe sandbox copies of products. Record the sandbox price ids.
3. **December–January:** build §4.1–4.6 against the sandbox. Ship them behind the
   `CHECKOUT_PROVIDER` flag, with Lemon Squeezy still the live provider.
4. **By mid-January 2027:** start the Migration Hub flow for real. That means the live products
   and prices (record live price ids), customer migration, and the mapping report.
5. Live-mode smoke test: a real Pro purchase and refund, and a real Enterprise purchase
   (refund it afterwards), the same checklist as LS Phase 5.3 step 6.
6. **Cutover day (target: early February 2027, no later than March 1):** flip
   `CHECKOUT_PROVIDER` to Stripe, adopt the new legal versions, update the docs, pricing and
   trust page copy, and unpublish the Lemon Squeezy storefront and products. The storefront is
   directly purchasable (`RELEASE_CHECKLIST.md` header) and would otherwise keep taking LS
   orders.
7. Send the Enterprise customer notices (§5), then confirm subscription migration in the
   Migration Hub (≥ 14 days' Stripe notice). Run the backfill script and verify every migrated
   license carries a `stripeSubscriptionId`.
8. **Before March 31:** export Lemon Squeezy orders, subscriptions and customers. Download the
   historical tax documents from the Lemon Squeezy payout account. Archive the Enterprise
   acceptance records: the LS order custom data **is** the acceptance record for every
   Enterprise order placed so far, so export it in a form that keeps the order id, the custom
   data, and the timestamps, and store it in the business Drive (not this repo; it holds
   customer legal-entity data). Confirm the final payout.
9. **After March 31, 2027:** delete `ls-webhook.ts`, `LemonSqueezyConstants.ts`, the LS webhook
   secret env var, the Lemon Squeezy webhooks, and the LS logo outputs in
   `generate-app-icons.mjs`. Keep the `ls*` metadata _readers_ until the last LS-era Enterprise
   license has renewed on Stripe. Update `RELEASE_CHECKLIST.md` Phase 5 and
   `CTRLYOKE_ACCOUNTS_PLAN.md`, then move this plan to `dev/implemented/`.

## 8. Open questions

1. **Subscription eligibility contradiction.** Stripe's docs say "Existing subscriptions aren't
   eligible" for Managed Payments; only new subscriptions bought through a Managed Payments
   Checkout are. The Lemon Squeezy docs say eligible card subscriptions migrate automatically.
   This probably refers to existing _Stripe_ subscriptions, with the Lemon Squeezy tooling as a
   separate path, but confirm in the Migration Hub before step 7. If LS subscriptions cannot
   move, Enterprise customers re-purchase through the new checkout before renewal. Then the
   backfill becomes "link a new checkout to an existing license", which needs a re-purchase
   flow that extends the existing license instead of minting a new one.
2. Does `consent_collection.terms_of_service` work with `managed_payments[enabled]`? Do
   `custom_fields` work? (Neither is documented.) If custom fields work, the legal name and
   address could be collected on Stripe's page, but our own acceptance form should stay the
   record either way.
3. Can we link Enterprise customers to a **Stripe Customer Portal** session for Managed
   Payments subscriptions, or only to link.com? This affects the renewal email and the
   Enterprise Terms wording.
4. B2B gaps: `tax_id_collection` is removed, and purchase orders, reverse charge, and invoices in
   the customer's legal name are undocumented. Do EU business buyers get VAT reverse-charge
   invoices from Link? Ask Stripe support. Enterprise-by-PO (`mailto:sales@`) stays a manual
   invoice path either way. Decide how those invoices are issued: Stripe Invoicing is outside
   Managed Payments, so Fuzzy Nova would be the merchant of record (and owe the tax) on them.
5. How many live Enterprise subscriptions exist, and what are their renewal dates? If one
   renews before the Stripe path is live, it renews on Lemon Squeezy as usual, which is fine
   until March 31.
6. Does the Lemon Squeezy mapping report include subscription ids, or only customer ids? This
   decides how the backfill script matches licenses.
7. Should the Pro price stay $59 given the different fee structure (about 3.5% + 2.9% + 30¢ after
   2027, against 5% + 50¢ now)? This is a business decision and doesn't block anything.

## Sources

Read November 25, 2026:

- https://docs.lemonsqueezy.com/migration, `/migration/faq`, `/migration/comparison`,
  `/migration/digital-fulfillment`
- https://docs.stripe.com/payments/managed-payments, `/how-it-works`, `/set-up`, `/eligibility`,
  `/use-payment-links`, `/update-checkout`, `/tax-compliance`
- https://docs.stripe.com/api/checkout/sessions/create

Not yet read: https://www.lemonsqueezy.com/blog/saying-goodbye-to-lemon-squeezy,
https://docs.lemonsqueezy.com/help/orders/exporting-orders,
https://support.stripe.com/questions/managed-payments-pricing.
