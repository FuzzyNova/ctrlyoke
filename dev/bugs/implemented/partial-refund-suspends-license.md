# Partial refund suspends the buyer's Keygen license

- **Found:** 2026-10-04 by Claude while deciding the refund policy ([`dev/backlog/REFUND_POLICY.md`](../../backlog/REFUND_POLICY.md))
- **Area:** `netlify/functions/ls-webhook.ts`
- **Resolution:** fixed in this commit

## Symptom

Any partial refund on a Lemon Squeezy order (a goodwill discount, or a sales-tax refund LS issues
after a buyer supplies a tax ID) suspends that buyer's Keygen license, the same as a full refund.
The paying customer loses Pro.

## Steps to Reproduce

1. Place a test-mode order for ctrlyoke Pro; the webhook creates the Keygen license.
2. In LS, **Orders → ⋯ → Refund** a partial amount.
3. LS sends `order_refunded` (it fires for full _and_ partial refunds; order `status` is
   `partial_refund`, `refunded` is `false`). The Keygen license is now suspended.

## Root Cause

The `LS_EVENT.ORDER_REFUNDED` case calls `suspendLicensesForOrder(payload.data.id)` unconditionally.
`LemonSqueezyOrderPayload` carries `status` but the handler never checks it, and the payload type
has no `refunded` field.

## Suggested Fix

Add `refunded: boolean` to `LemonSqueezyOrderPayload.data.attributes` and only suspend when
`refunded === true` (or `status === "refunded"`, single-sourced as a constant alongside
`LS_BILLING_REASON`). Return `200 "Ignored (partial refund)"` otherwise, matching the existing
`"Ignored (not paid)"` shape.
