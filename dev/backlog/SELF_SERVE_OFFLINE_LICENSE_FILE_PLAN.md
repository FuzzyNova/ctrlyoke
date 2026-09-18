# Self-Serve Offline License File Download

**Created:** September 17, 2026
**Status:** Implemented — Option B shipped 2026-09-17 (design verified 2026-09-17, see
[Verified design](#verified-design-for-option-b)). Option C remains backlog.
**Found via:** live air-gapped-activation test on 2026-09-17 (see
[`../active/RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 12). Nathan, as the
Keygen account admin, generated the signed license file himself from the Keygen dashboard and
confirmed `importLicenseFile()` works end-to-end. A real customer has no equivalent path today.

## Option B implementation

The self-serve page is live at [`landing/src/pages/license/offline.astro`](../../landing/src/pages/license/offline.astro),
and builds to `https://ctrlyoke.dev/license/offline/`. It validates a pasted key and checks out
the plain signed certificate entirely in the browser, offering both a `.lic` download and
copyable certificate text. The page requests a one-year checkout TTL and retries with the
extension's 30-day TTL only when Keygen rejects the longer value; it never activates a machine or
requests encryption.

The shared Keygen identifiers and fallback TTL now live in
[`src/license/KeygenConstants.ts`](../../src/license/KeygenConstants.ts), with compatibility
re-exports from `LicenseService.ts`. The landing site imports that dependency-free module
directly; no generated landing-local copy was needed because the cross-project import works in
the static landing build. Option C remains intentionally untouched.

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

## Verified design for Option B

Everything in this section was checked against the live Keygen API and the shipped
`src/license/LicenseService.ts` on 2026-09-17. Treat it as the implementation contract — it
resolves the questions the rest of this document left open.

### The page is genuinely static — CORS confirmed

A browser on `https://ctrlyoke.dev` can call both required endpoints directly. Preflighting each
one with `Origin: https://ctrlyoke.dev` returns `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`, and — critically for
license-key auth — echoes `authorization` back in `Access-Control-Allow-Headers`:

- `OPTIONS /v1/accounts/<account>/licenses/actions/validate-key` (requesting `POST`) → `200`
- `OPTIONS /v1/accounts/<account>/licenses/<id>/actions/check-out` (requesting `GET` with
  `authorization`) → `200`

So no Netlify function, no proxy, and no server-held token is needed. This was the single
make-or-break risk for Option B and it is cleared.

### Exact call sequence the page must make

Mirror `LicenseService`'s own online path so the file the page produces is byte-compatible with
what the extension already accepts:

1. `POST /licenses/actions/validate-key` with body `{"meta":{"key":"<pasted key>"}}` and no
   `Authorization` header — this is how the page turns a key into a license **id**
   (`LicenseService.validateKey`, `src/license/LicenseService.ts`). Accept the same set of
   outcomes the extension accepts: `meta.valid === true`, or code `NO_MACHINES`,
   `FINGERPRINT_SCOPE_MISMATCH`, or `TOO_MANY_MACHINES` — a key that is merely unactivated or at
   its machine limit can still legitimately mint a file.
2. Confirm `data.relationships.product.data.id` is `KEYGEN_PRODUCT_ID` and
   `data.relationships.policy.data.id` is one of `KEYGEN_VALID_POLICY_IDS`, matching
   `assertExpectedRelationship`, so a key for some other Keygen product gets a clear error rather
   than a confusing one.
3. `GET /licenses/<id>/actions/check-out?ttl=<seconds>` with `Authorization: License <key>`
   (`LicenseService.checkoutLicense`). **No machine activation step** — the page must never `POST
/machines`; checkout is a read-style action and does not consume one of the license's activation
   slots (confirmed on the live account 2026-09-17).

### Two hard constraints on the checkout call

- **Never pass `encrypt=true`.** The file must come back as plain `base64+ed25519`. An air-gapped
  machine importing a file has no license key in its credential store, so
  `LicenseService.decryptLicensePayload` has nothing to decrypt an `aes-256-gcm+ed25519` payload
  with and `importLicenseFile` would silently fall back to the existing (free) entitlement.
- **The download must be the `-----BEGIN LICENSE FILE-----` certificate text.** `parseCertificate`
  accepts only that envelope. Keygen's checkout action may answer with either the raw certificate
  body or a JSON:API document carrying it at `data.attributes.certificate`, so the page should
  handle both and write the certificate text out either way.

### TTL

`entitlementFromPayload` enforces the file's own `meta.expiry` **only** for
`LICENSE_SOURCES.ONLINE`; an imported `offline-file` is bounded by the underlying license's expiry,
not by the file TTL. A long TTL is therefore the friendlier choice for an air-gapped machine (it
avoids re-minting for cosmetic reasons) — request roughly one year and fall back to the extension's
`LICENSE_FILE_TTL_MS` (30 days) if the policy's max TTL rejects it.

### Keygen identifiers must stay single-sourced

`KEYGEN_ACCOUNT_ID`, `KEYGEN_PRODUCT_ID`, the two policy IDs, and `KEYGEN_API_BASE_URL` live in
`src/license/LicenseService.ts` today. The page needs the same values, and re-typing them into
`landing/` would create exactly the duplicated-constant problem the project's DRY rule exists to
prevent. Extract them into a small dependency-free module the landing site can import (no
`node:crypto`, no VS Code imports), re-exported from `LicenseService.ts` so existing importers are
untouched. `landing/` already imports across the project root (`terms.astro` imports root
`LICENSE.md`; `HarnessDeck.astro` imports from `images/`), and `astro.config.mjs`'s
`server.fs.allow: [".."]` permits it. If that cross-project import turns out to be brittle,
generate a landing-local constants file from the extension module with a `scripts/generate-*.mjs`
step instead — do not hand-copy the IDs.

### Route and surface

`https://ctrlyoke.dev/license/offline/` (`landing/src/pages/license/offline.astro`). Standard
`Layout.astro`, and follow `HarnessDeck.astro`'s pattern of a `<script define:vars={{ ... }}>` block
for passing build-time constants into browser code. The page must offer both a file download and a
copy-to-clipboard view of the certificate, because the extension accepts a picked file _or_ pasted
text.

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
