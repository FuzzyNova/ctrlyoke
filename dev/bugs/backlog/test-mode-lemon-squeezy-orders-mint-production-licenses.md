# Test-mode Lemon Squeezy orders mint real production licenses

- **Found:** 2026-10-17 by release-ready audit workflow (Claude, code-sanity + landing auditors, confirmed by verifier)
- **Area:** `netlify/functions/ls-webhook.ts` (`KEYGEN_POLICY_BY_LS_VARIANT` ~L62-78), `src/license/LemonSqueezyConstants.ts` (~L20-38)
- **Severity:** critical (blocks the repo-public flip)

## Symptom

A test-mode Lemon Squeezy checkout paid with Stripe's public test card (`4242 4242 4242 4242`)
produces a real, working Keygen license on the production Pro or Enterprise policy, and the
license key is emailed to the buyer. The test-mode checkout URLs are committed to the repo, so once
`FuzzyNova/ctrlyoke` is public anyone who reads the source can get free Pro, or a free 1-year
Enterprise license. Each license also counts against the Keygen Dev-tier cap of 100 licensed users.

## Steps to Reproduce

1. Open the test-mode Pro checkout from `LS_CHECKOUT_URLS.test` in
   `src/license/LemonSqueezyConstants.ts`. The verifier's curl returned a 302 to a published cart
   with `"test_mode": true`.
2. Pay with the Stripe test card.
3. Test webhook `129600` posts `order_created` to the production
   `https://ctrlyoke.dev/.netlify/functions/ls-webhook`, with the same signing secret as the live
   webhook (`RELEASE_CHECKLIST.md` ~L506).
4. `ls-webhook.ts` resolves the test variant (`2059579` / `2105478`) to the production Keygen
   policy, then calls `createLicense` and `sendLicenseEmail`.

## Root Cause

`KEYGEN_POLICY_BY_LS_VARIANT` is built from both `LS_VARIANT_IDS.live` and `LS_VARIANT_IDS.test`,
on purpose ("Both modes are mapped so test-mode purchases keep working after launch"). Nothing
gates issuance on `meta.test_mode`: it is read only to add a `[TEST]` prefix to the Enterprise
alert subject (~L461). That was fine while the repo was private, because the test checkout links
were known only to the owner. Section 14.3 of the checklist cleared the variant IDs and the test
card as safe to publish as identifiers, but it never considered this path.

## Suggested Fix

Do at least one of these before the repo flip. The test checkout UUIDs are already in git history,
so removing them from HEAD does not fix this on its own.

1. **Code (preferred):** in `ls-webhook.ts`, skip license issuance (respond 200 with a no-op) when
   `meta.test_mode === true` unless an env flag such as `ALLOW_TEST_MODE_ORDERS` is set. Leave the
   flag unset on production and set it only on a preview deploy. Alternatively, route test-mode
   orders to a separate short-expiry Keygen test policy.
2. **Dashboard:** delete or disable test webhook `129600`, or point it at a deploy preview. Or
   unpublish/archive the test-mode products.
3. Redeploy with a manual `workflow_dispatch` of `deploy.yml`, because `netlify/**` is outside the
   push path filter. Also consider revoking any stray test-issued licenses in Keygen.
