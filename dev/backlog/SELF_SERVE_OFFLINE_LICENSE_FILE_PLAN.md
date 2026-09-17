# Self-Serve Offline License File Download

**Created:** September 17, 2026
**Status:** Backlog — not started.
**Found via:** live air-gapped-activation test on 2026-09-17 (see
[`../active/RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 12). Nathan, as the
Keygen account admin, generated the signed license file himself from the Keygen dashboard and
confirmed `importLicenseFile()` works end-to-end. A real customer has no equivalent path today.

## The gap

[`docs/pro/index.md`](../../docs/pro/index.md) tells air-gapped customers to "obtain the signed
license file from the Keygen customer portal or from your organization's Keygen administrator."
Neither half of that sentence is actually true for a normal Pro buyer right now:

- There is no configured Keygen customer portal — only the admin dashboard exists
  ([`../active/RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 4 has no such item).
- A one-time $59 individual buyer has no "organization's Keygen administrator" — that's Nathan,
  and he is not a support channel for minting files one at a time.

So today, air-gapped activation only works for licenses Nathan personally generates a file for.
That's fine for the Enterprise tier (which already has a real admin — the buyer's own Keygen-side
contact per-seat isn't a thing, but the model assumes an IT admin exists), but it's broken for the
individual Pro SKU, which is exactly the segment most likely to actually be air-gapped (a dev
machine with no network by policy).

## What "self-serve" actually requires

A customer only ever holds their **license key** (never an admin/product token — see the security
boundary already established in
[`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.4: "the extension only ever holds
the Keygen account public key... and the user's own license key/file"). Keygen's license-file
checkout is designed for exactly this: the "check out a license" action can be called with
**license-key authentication** (`Authorization: License <key>`) instead of an admin token, so a
customer's own key is sufficient to mint their own signed license file with no server in the
middle.

One thing is now confirmed, one is still open, checked against the live Keygen dashboard on
2026-09-17:

1. ~~**License-key authentication strategy must be enabled...**~~ **Confirmed (2026-09-17):** both
   the ctrlyoke Pro and ctrlyoke Enterprise policies already have Authentication Strategy set to
   `LICENSE` in the Keygen dashboard (Products → ctrlyoke → Policies → each policy's settings). No
   policy change needed before building either option below.
2. ~~**Confirm the checkout action doesn't consume a machine-activation slot.**~~ **Confirmed
   (2026-09-17):** checking out a license file did not change the machine count on the test
   license. Checkout is a read-style action against the license, not a machine activation — a
   self-serve download will not burn one of the customer's 10 activation slots.

Both prerequisites are now verified against the live account. Nothing blocks starting on Option B.

Whatever surface is built, it must be a **pure client-side call to Keygen's public API** — no
ctrlyoke backend, no Netlify function holding a secret. The moment an admin/product token needs to
sit behind this feature to make it work, the design is wrong and has recreated the "someone has to
mint it for you" problem, just moved to different infra.

## Option A — Keygen-hosted customer portal

Keygen may offer (tier-dependent) a hosted self-service portal product. Not evaluated here in
detail because it's the weakest fit even if available: it lives on Keygen's domain, not
`ctrlyoke.dev`, so it breaks the buyer's trust chain (support docs, purchase, everything else is
first-party), and white-labeling is typically a higher Keygen plan than the current Dev/starter
tier decided in `../active/RELEASE_CHECKLIST.md` §4.3. Worth a five-minute check of current Keygen
pricing before ruling it out entirely, but default to no.

## Option B — a page on ctrlyoke.dev (recommended first)

A page (e.g. `ctrlyoke.dev/license/offline` or similar) that:

1. Takes a pasted license key.
2. Calls Keygen's license checkout action directly from the browser using `Authorization: License
<key>` — no ctrlyoke backend involved at all; this can be a fully static page.
3. Downloads the resulting `.lic` blob (or shows it for copy/paste, matching the extension's
   existing "paste it in here" affordance).

This is the actual fulfillment of what `docs/pro/index.md` already promises ("customer portal"),
works from any browser on any connected device (a work laptop, a phone, a kiosk — nothing to
install), and is the only option that helps a customer who wants to prep a license file _before_
they've put ctrlyoke on any machine at all. It also matches the existing pattern of `ctrlyoke.dev`
owning the pricing/checkout/portal surface per
[`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.9.

Rate-limit consideration: since this is a public static page hitting Keygen directly from the
browser, abuse is bounded by Keygen's own per-key/per-IP rate limits on the checkout action, not by
anything ctrlyoke needs to build — another point in favor of not putting a Netlify function in the
path.

## Option C — a section in `LicenseSection.tsx` (fast follow, not a substitute)

Once Option B's client-side Keygen call is proven out, add a small "Generate a license file for
another machine" action next to the existing "Activate with license key" section in
[`LicenseSection.tsx`](../../src/ui/webview-react/components/settings/LicenseSection.tsx) (around
line 241, alongside the existing `MESSAGE_TYPES.ACTIVATE_LICENSE_KEY` flow). This only helps a
customer who already has ctrlyoke running Pro on one connected machine and wants to mint a file to
carry over to a _second_, air-gapped machine — a real but narrower case than Option B. It's cheap
to add given the checkout call and UI patterns already exist from B, but doesn't stand alone: it
does nothing for a customer with no connected ctrlyoke install anywhere.

## Recommendation

Build **B**, ship it, update `docs/pro/index.md`'s air-gapped section to link to it instead of the
vague "customer portal or your org's Keygen administrator" line. Add **C** afterward as a
convenience for existing Pro users, reusing the same Keygen call. Skip **A** unless the Keygen
pricing check turns up a white-label portal already included at the current tier.

## Out of scope for this plan

- QR-code transfer for the generated file — already deferred in
  [`PRO_LICENSE_PLAN.md`](../implemented/PRO_LICENSE_PLAN.md) §1.5 and unrelated to _how_ the file
  is obtained.
- The Phase-2 "Sign in with ctrlyoke" device-code flow
  ([`PRO_LICENSE_FOLLOWUPS_PLAN.md`](PRO_LICENSE_FOLLOWUPS_PLAN.md) item 2) — this plan is
  key-only and doesn't depend on it.
