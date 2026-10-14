# Refund Policy (Pro + Enterprise)

**Created:** October 4, 2026
**Status:** Partial. The repo side is implemented; the Lemon Squeezy dashboard steps and the
test-mode refund check are still open. Launch work is tracked from
[`../active/RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 7 (refund item) and
Phase 12 (refund check).

> **2026-10-10 audit:** All three code and copy items are done. `87ba0728a` suspends only on full
> refunds, handles `subscription_payment_refunded`, and adds the pricing FAQ, the Pro card line
> ("30-day money-back guarantee.") and the `docs/pro/index.md` "Buy Pro" sentence. `1eae68844`
> added the refund confirmation email (`sendRefundEmail`). The "What exists today" table below is
> the pre-decision snapshot: the pricing page and `docs/pro/index.md` now state the policy. Still
> open, none of it verifiable from the repo: steps 1–3 under "Manual steps in Lemon Squeezy" below
> (product description and receipt copy, `subscription_payment_refunded` on the test **and**
> live-mode webhooks, and the test-mode full/partial refund check).
>
> **Pre-release: yes.** The published policy is already live on the pricing page, so the LS
> product and receipt copy must match it before the first real sale. The live-mode webhook (created
> when Test mode is flipped off) must also subscribe to `order_refunded` and
> `subscription_payment_refunded`, or refunds won't suspend licenses or send the confirmation
> email. Both are dashboard clicks, not code.
> **Related:** [`../implemented/PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) (the
> LS → Netlify → Keygen pipeline), [`../../ENTERPRISE_TERMS.md`](../../ENTERPRISE_TERMS.md) §6–7,
> [`../../LICENSE.md`](../../LICENSE.md) §6(e),
> [`../bugs/implemented/partial-refund-suspends-license.md`](../bugs/implemented/partial-refund-suspends-license.md).

---

## What existed before the decision (October 4, 2026)

| Where                             | What it says                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENTERPRISE_TERMS.md` §7          | Enterprise fees are **non-refundable** except as required by law or stated in an Order. No credit for a partially used term. Refunds are administered under LS's buyer terms; a refund may suspend/adjust the license. |
| `ENTERPRISE_TERMS.md` §6          | Cancellation stops renewal at term end and does not refund the unused term.                                                                                                                                            |
| `LICENSE.md` §6(e)                | A license may be revoked for fraudulent purchase, payment reversal, or chargeback. **Says nothing about refunds for Pro.**                                                                                             |
| Pricing page, `docs/pro/index.md` | **Nothing.**                                                                                                                                                                                                           |
| `netlify/functions/ls-webhook.ts` | `order_refunded` → suspend the Keygen license for that order (since `87ba0728a`: full refunds only; renewal refunds also handled).                                                                                     |

So the **individual Pro ($59) SKU has no refund policy at all**. A buyer reading the site can't tell
whether a refund is possible, and the only governing text is Lemon Squeezy's buyer terms
("refunds are provided at the sole discretion of Lemon Squeezy").

## How Lemon Squeezy refunds work (verified October 4, 2026)

- **No automatic refunds.** There is no store setting that auto-approves refunds within a window.
  The seller issues each one: dashboard **Orders → ⋯ → Refund** (full or partial), or the API
  (`POST /v1/orders/:id/refund`, `POST /v1/subscription-invoices/:id/refund`). Nothing needs to be
  "enabled" — refunding is always available.
- **LS can refund over your head.** LS "reserves the right to issue refunds within 60 days of
  purchase, at its own discretion, in order to prevent chargebacks." Any policy stricter than ~60
  days is therefore not fully enforceable in practice.
- **The platform fee is not returned.** The refunded amount minus LS's fee is deducted from the next
  payout — each refund costs the fee (~5% + 50¢, ≈ $3.45 on $59; ≈ $225 on $4,499; verify the
  current rate). A **chargeback** costs the refund plus a **$15 dispute fee** — so a quick, easy
  refund is strictly cheaper than a dispute.
- **LS buyer terms:** no refunds on unused subscription periods; the EU/UK withdrawal right is
  waived once digital delivery begins (LS handles that consent at checkout — nothing for us to add).
- **Webhooks:** `order_refunded` fires on **full or partial** order refunds (order `status` becomes
  `refunded` or `partial_refund`; `refunded` is `true` only when fully refunded).
  Refunding a **subscription renewal invoice** fires `subscription_payment_refunded`, not
  `order_refunded`.

Sources: [LS refunds & chargebacks](https://docs.lemonsqueezy.com/help/payments/refunds-chargebacks),
[LS buyer terms](https://www.lemonsqueezy.com/buyer-terms),
[Issue a refund API](https://docs.lemonsqueezy.com/api/orders/issue-refund),
[Webhook event types](https://docs.lemonsqueezy.com/help/webhooks/event-types),
[Order object](https://docs.lemonsqueezy.com/api/orders/the-order-object).

---

## Decision

### Pro ($59 perpetual): 30-day, no-questions-asked, full refund

- **30 days from purchase**, full refund, no justification required. Refunding suspends the license
  (already automated by the webhook).
- **Why 30 days:** it's the dev-tool norm (buyers expect it on a one-time purchase), it sits inside
  LS's own 60-day discretionary window so the promise never contradicts what LS might do anyway,
  and at $59 one human click is cheaper than a $15 chargeback or a bad review. The 14-day remote
  trial reduces how many refunds are needed; it doesn't replace the window (the trial covers
  remote access before purchase, not "it doesn't work on my setup" after).
- **After 30 days:** no refunds, except at Nathan's discretion (e.g. a bug that makes Pro unusable
  for them) or where required by law.
- **Refund abuse is an accepted, bounded risk.** A buyer could check out an offline license file
  at `ctrlyoke.dev/license/offline/` and then refund: suspension stops online clients within the
  30-day file TTL, but an offline file keeps working until its own expiry (one year — see
  [`../implemented/SELF_SERVE_OFFLINE_LICENSE_FILE_PLAN.md`](../implemented/SELF_SERVE_OFFLINE_LICENSE_FILE_PLAN.md)).
  That is the same honor-system threat model as the bind gate (PRO_LICENSE_PLAN §1.8); EULA §4(c)
  is the backstop. Reserve the right to refuse requests showing a refund-abuse pattern (repeat
  buy/refund), which LS's buyer terms also allow.

### Enterprise ($4,499/yr): keep the existing terms — non-refundable

- **No change to `ENTERPRISE_TERMS.md` §6–7.** Annual site licenses that are non-refundable once the
  term starts are standard, and the terms are already attorney-reviewed; adding a window would mean
  a version bump and another review.
- **Why it's fair without a window:** an org can evaluate everything free forever, test remote
  access with the 14-day trial, and buy a $59 Pro first. Renewal gets a 30-day reminder (§4(b)) and
  can be cancelled any time before renewal (§6).
- **Discretionary exceptions** (Nathan's call, case by case, using §7's "expressly stated in an
  Order" / LS discretion): duplicate purchase, wrong product bought, or a renewal charged when the
  customer demonstrably tried to cancel. Expect LS may also refund within 60 days to head off a
  chargeback; the webhook handles license suspension either way.

---

## Messaging

Short, plain, and the same wording everywhere.

**Pricing page FAQ** (`landing/src/pages/pricing.astro`, `faq` array):

> **What's your refund policy?**
> Pro comes with a 30-day money-back guarantee: email billing@ctrlyoke.dev within 30 days of
> purchase for a full refund, no questions asked. Your license is deactivated when the refund is
> processed. Enterprise subscriptions are non-refundable once the term starts — see the
> Enterprise Terms — but you can cancel any time before renewal.

**Pro tier card:** one muted line under the price — "30-day money-back guarantee."

**`docs/pro/index.md` → "Buy Pro":** one sentence with the same 30-day promise and the billing
address.

**Lemon Squeezy product description / confirmation copy (Pro):** append "30-day money-back
guarantee — email billing@ctrlyoke.dev."

**Refund confirmation email:** sent automatically by the webhook on a full refund (see the
runbook below).

**License-key email** (`sendLicenseEmail` in `ls-webhook.ts`): no change needed — keep that email
about activation. (Optional one-liner if a buyer's first question tends to be "how do I get a
refund".)

**Enterprise pricing card:** no new copy; it already links the Enterprise Terms.

Use **billing@ctrlyoke.dev** for refund requests (already the billing/cancellation address in the
Enterprise Terms), not support@ — it keeps money requests out of the support queue.

---

## Implementation

### Code (small)

- [x] Fix [`partial-refund-suspends-license`](../bugs/implemented/partial-refund-suspends-license.md):
      suspend only on a **full** refund. Needed before any goodwill partial refund (or an LS
      tax-only refund) is ever issued.
- [x] Enterprise renewal refunds: handle `subscription_payment_refunded` by suspending the
      subscription's license (look up by `lsSubscriptionId`). Without it, refunding a renewal
      invoice leaves the license extended for another year. Low priority given the no-refund
      policy — the manual alternative is suspending the license in the Keygen dashboard after
      issuing such a refund.
- [x] Pricing FAQ entry + Pro card line; `docs/pro/index.md` sentence (copy above).

Do **not** automate refunds through the LS API (would need an LS API key in Netlify, an
abuse-prone self-serve endpoint, and buys nothing at this volume).

### Manual steps in Lemon Squeezy

Nothing has to be switched on to allow refunds. To launch the policy:

1. **ctrlyoke Pro → edit product:** add the refund line to the description and the
   confirmation-modal / receipt copy (the same field that already explains the separate key email).
2. **Webhooks (test and live mode):** confirm the webhook includes `order_refunded`, and add
   `subscription_payment_refunded` (the handler now exists; without the subscription the event never arrives).
3. **Test mode:** run the Phase 12 refund check — refund a test order, confirm the Keygen license
   is suspended; then a partial refund, confirm it is **not**.

### Per-request runbook (Pro)

1. Request arrives at billing@ctrlyoke.dev → find the order in LS by email.
2. Within 30 days → **Orders → ⋯ → Refund → full amount**. That is the only manual step: the
   webhook suspends the Keygen license and emails the buyer a refund confirmation (from
   `sendRefundEmail`, reply-to billing@).
3. If the buyer never got the confirmation, check the Netlify function log and the license in
   Keygen (**Suspended**, `refundNotifiedId` set); suspend by hand if the webhook failed.
