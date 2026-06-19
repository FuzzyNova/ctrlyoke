# FlightPath Pro Licensing Plan

**Created:** June 12, 2026
**Status:** PLANNING
**Roadmap item:** 0.B (launch blocker) / 4.2 (Pro tier)
**Split from:** [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md) Phase 5 (Pro Licensing) — moved here so the long-term model is decided on its own merits.
**Launch dependency:** create the `flightpath.dev` business email/support identity and vendor account ownership first; tracked in [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

---

## Decision Record

**Chosen architecture: Lemon Squeezy (storefront / Merchant of Record) + Keygen (licensing), with offline cryptographic licensing and air-gapped activation supported from launch.**

| Concern | Owner | Why |
| ------- | ----- | --- |
| Checkout, payment, **global tax/VAT (Merchant of Record)**, receipts, refunds | **Lemon Squeezy** | Already have an account; mature MoR; we own no payment/tax liability |
| License issuance, **Ed25519-signed offline license files**, machine/device limits, expiry, revocation, air-gapped activation | **Keygen** | Purpose-built licensing; offline crypto is its core competency, not a bolt-on |
| Glue (purchase → license) | **Netlify Function** | We're already deploying the site on Netlify ([`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md)); one serverless webhook handler |

**Activation model: license key now, user accounts as a later UX layer.** A pasted Keygen license key (or imported license file) at launch; "Sign in with FlightPath" device-code flow added later when the hosted dashboard becomes a paid cloud product. Both sit behind a single `LicenseService` interface, so Phase 2 is an internal swap.

**License model: source-available under a custom commercial EULA with an enterprise revenue threshold** ($10M revenue / 250 employees). See [License & Commercial Terms](#license--commercial-terms).

### Why this architecture

1. **Local feature gating needs an *entitlement*, not an *identity*.** Unlocking Pro inside the extension requires verifiable proof of purchase. A user-account system only earns its keep when there are server-side resources to protect (the hosted dashboard). Until then, accounts are infrastructure maintained for no functional gain.
2. **Offline-verifiable beats phone-home.** Keygen issues license files cryptographically signed with **Ed25519** (optionally AES-256-GCM encrypted) carrying a tamper-proof snapshot of the entitlement + expiry, verifiable against an embedded public key **with no network**. This delivers the things we want: enterprise/airgapped support, privacy (no per-check call-home), resilience when our backend is down, and zero per-check latency.
3. **Lemon Squeezy alone can't do this; neither can any payment processor.** LS license keys are online-validated strings — no signed offline artifact, no grace, no air-gapped story. That's not a knock on LS; it's just not a licensing system. Pairing a checkout (LS) with a licensing system (Keygen) is the standard way to get both.
4. **Keygen does hybrid online + offline from one integration**, so supporting air-gapped enterprise customers costs consumer users nothing — normal online activation and offline license files come from the same vendor and the same `LicenseService`.
5. **Buy, don't build the crypto.** Signing a token yourself is ~50 lines, but the *lifecycle* — issuance on purchase, revocation on refund/chargeback, seat/device limits, expiry/refresh, re-download portal — is the real cost. Keygen provides the lifecycle and the crypto.

### Why support air-gapped/enterprise from the start (not later)

The license **format** you issue is painful to migrate. Launching on simple online-only keys and later moving to signed offline files would force re-issuing every existing customer's license. Because Keygen serves consumer (online) and enterprise (offline/air-gapped) from one integration, adopting it up front costs little and avoids a future migration. Enterprise/airgapped buyers are a real, high-value segment for developer tooling.

---

## License & Commercial Terms

**Model: source-available + a custom commercial EULA with an enterprise revenue threshold.**

### Decisions

- **Source-available, not closed.** Public repo, source visible, governed by the custom EULA. Rationale: a VS Code `.vsix` already ships the (bundled) JS to every user, so closing the source hides little of substance; meanwhile visible source builds trust for a tool that drives AI over user codebases, runs a local server, and phones home for licensing — and it eases the **enterprise security review** that our revenue-threshold targets often require. Pro protection comes from the **EULA** (legal) + **Keygen offline crypto** (a gate-patched build still can't mint a valid signed license), **not** from source secrecy.
- **Label it "source available," never "open source."** It is not OSI-approved — it carries use restrictions. Mislabeling invites community backlash.
- **Custom commercial EULA, not a standard license.** Avoid **BSL/FSL** (their time-delayed conversion would hand the code to competitors after N years — wrong for an indefinitely-commercial product) and avoid **AGPL/SSPL** (enterprise legal bans them). The EULA is bespoke, in the spirit of Docker's/Unity's terms.

### What the EULA must contain

- **Free use for individuals and small businesses.**
- **Commercial-use threshold:** organizations above **$10M USD annual revenue OR 250 employees** (Docker's exact line — already recognized by enterprise legal teams) must purchase Pro licenses for commercial use — **even if they only use free/local features and never need the server.** This is the enterprise-compliance capture; it is **contractual, not technically enforced** (honor-system, like Unity/Docker).
- **No circumventing the license key** / no unlocking Pro features without a license — the legal backstop for the freemium gate (ELv2 already has this clause; we keep the equivalent).
- **Optional anti-SaaS-resale** clause (no offering FlightPath to third parties as a competing hosted service).
- Standard warranty disclaimer, liability limit, termination, patent/notice terms.
- **No forced open-source conversion** (no BSL-style Change Date).

> **Replace the current placeholder.** `LICENSE` currently contains **Elastic License 2.0**. ELv2 is correctly source-available and *does* protect the license-key gate, but it grants **everyone — including large enterprises — free commercial use**, so it does **not** deliver the revenue threshold. Swap it for the custom EULA before launch.

> **Not legal advice.** Have an attorney draft/review the final EULA — the revenue clause only matters if it is enforceable and clean.

### Where the EULA lives

- `LICENSE` / `LICENSE.md` in the repo — the canonical text.
- `package.json` → `"license": "SEE LICENSE IN LICENSE.md"` (custom license; not a standard SPDX id once it diverges from ELv2).
- `flightpath.dev/terms` — web-facing copy + plain-language summary.
- `docs/pro/index.md` — a "Who needs a license?" explainer with the threshold in plain language.
- VS Code Marketplace listing + README — one line: _"Free for individuals and small businesses; organizations over $10M revenue or 250 employees require a Pro license."_
- Optional first-run/about notice in the extension linking to the terms.

### Support & feedback model (layered)

| Channel | Audience | Tool |
| ------- | -------- | ---- |
| **Public GitHub Issues** (main repo — source is public) | Community bug reports, dedup, transparency | GitHub (free) |
| **Private support inbox** `support@flightpath.dev` | Pro / Enterprise (the tier promises email support); enterprises won't post internal usage publicly and want an SLA | Plain / Pylon / Help Scout |
| **Auto crash/error reporting** (later) | Telemetry, not user-filed | Sentry (ties into 2.2 telemetry) |
| **Public roadmap / feature voting** (optional, later) | Demand signal | Canny / Featurebase |

The non-obvious addition for a commercial product: a **private** support path for paying customers *alongside* the public tracker — enterprises specifically do not want bug reports (which can reveal what they're building) sitting on public GitHub. The public/private split also doesn't force the source decision: even a closed-source product can run a code-less public "issues-only" repo, so the bug-tracker benefit is available independent of source visibility.

---

## Architecture Overview

```
                 ┌─────────────────┐
   buyer ───────►│  Lemon Squeezy  │  checkout · payment · tax (MoR) · receipt
                 └────────┬────────┘
                          │ order_created webhook (HMAC-signed)
                          ▼
                 ┌─────────────────────┐
                 │  Netlify Function   │  verifies LS signature, calls Keygen
                 │  (server-side only) │  (Keygen admin token lives here, never shipped)
                 └────────┬────────────┘
                          │ POST /v1/licenses  (+ policy = perpetual Pro)
                          ▼
                 ┌─────────────────┐
                 │     Keygen      │  issues license key + signed license file
                 └────────┬────────┘
                          │ key delivered to buyer (LS custom fulfillment / our email)
                          ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  VS Code extension — LicenseService                                │
   │   • online:    paste key → Keygen activate → cache signed file     │
   │   • air-gapped: import signed license file (USB/QR) → verify       │
   │   • verify:    Ed25519 signature + expiry, OFFLINE, embedded pubkey │
   └──────────────────────────────────────────────────────────────────┘
```

**Security boundary:** the extension only ever holds the **Keygen account public key** (for verification) and the user's **own** license key/file. The Keygen admin/API token and the LS webhook secret live **only** in the Netlify Function's environment — never in the VSIX.

---

## Phase 1 — Launch Licensing (v0.1.0)

### 1.1 Roles

- **Lemon Squeezy** — one product (**FlightPath Pro**, perpetual). Used purely as storefront + MoR. We do **not** use LS's native license keys; Keygen issues the real license. Disable/ignore LS key generation, or use LS custom fulfillment to deliver the Keygen key.
- **Keygen** — one **Policy** (perpetual Pro, Ed25519 scheme, encrypted license files, machine activation limit = 3). Licenses are created per purchase via the webhook.
- **Netlify Function** — `netlify/functions/ls-webhook.ts`: verify LS HMAC signature, on `order_created` call Keygen `POST /v1/licenses`, then deliver the key to the buyer.

### 1.2 Purchase → license issuance flow

```
LS order_created  →  Netlify fn verifies HMAC  →  Keygen create license (policy: pro-perpetual)
                  →  attach buyer email as metadata  →  deliver Keygen license key to buyer
```

Idempotency: key the Keygen license off the LS order ID so webhook retries don't mint duplicates. On `refund`/`order_refunded`, the webhook **revokes/suspends** the Keygen license.

### 1.3 Cryptographic license files (the offline core)

Keygen license files are a tamper-proof, signed snapshot of the license + entitlements + expiry:

- **Signed with Ed25519** (Keygen default scheme); optionally **AES-256-GCM encrypted**.
- Verified with **only the Keygen account public key** — embedded in the extension bundle. No network, no Keygen call.
- Tampering with any field (e.g. `expiry`, `tier`) fails signature verification.
- Files carry an `expiry`/TTL; the extension re-downloads a fresh file when online (online users) or the customer is issued a new file on renewal (air-gapped).

This is what gives us offline verification, airgapped support, and backend-downtime resilience simultaneously.

### 1.4 `LicenseService` (extension)

Create `src/license/LicenseService.ts`. Single interface; Keygen is its Phase-1 implementation; Phase-2 sign-in slots in behind the same surface.

```typescript
export interface Entitlement {
  tier: "free" | "pro";
  features: ReadonlySet<string>;
  expiresAt: number | null;       // epoch ms; null = perpetual
  licenseId?: string;
  source?: "online" | "offline-file";
}

export interface LicenseService {
  /** Verify the cached signed license file OFFLINE (Ed25519 + expiry). Never throws → free. */
  getEntitlement(context: vscode.ExtensionContext): Promise<Entitlement>;
  isPro(context: vscode.ExtensionContext): Promise<boolean>;

  /** Online: activate a pasted key with Keygen, then cache the signed license file. */
  activateWithKey(key: string, context: vscode.ExtensionContext): Promise<Entitlement>;

  /** Air-gapped: import a signed (.lic) license file blob, verify offline, cache. No network. */
  importLicenseFile(blob: string, context: vscode.ExtensionContext): Promise<Entitlement>;

  /** Refresh the cached signed file from Keygen when online and near expiry. */
  refresh(context: vscode.ExtensionContext): Promise<void>;

  /** Phase 2 stub: device-code/OAuth sign-in that fetches the license. */
  activateWithSignIn?(context: vscode.ExtensionContext): Promise<Entitlement>;

  deactivate(context: vscode.ExtensionContext): Promise<void>;

  readonly onDidChangeEntitlement: vscode.Event<Entitlement>;
}
```

Implementation notes:

- **Embed** the Keygen account **public key** as a build constant; verify the cached license file's Ed25519 signature locally on every `getEntitlement()`.
- **Storage:** license key + signed license file in `context.secrets` (`vscode.SecretStorage`) — they are bearer credentials.
- **Offline grace:** if the cached file is past `expiry` *and* the network is unreachable, honor the last-known entitlement for a bounded window (e.g. 14 days) before downgrading to free. Never hard-fail a paying user for being offline.
- **Fail open to *free*, never crash:** any verification error → free tier + non-blocking notice. Pro absence must never break core functionality.
- **Feature keys are single-sourced** in `DashboardConstants.ts` (`PRO_FEATURES.HOSTED_DASHBOARD`, etc.) — no hardcoded strings at gate sites.
- Use the official **`@keygen-sh/*`** verification approach / examples for the offline signature + decryption path; do not hand-roll crypto.

### 1.5 Activation flows (both shipped at launch)

**Online (consumer default):**
```
"FlightPath: Activate Pro License"
  → InputBox: paste Keygen license key
  → activateWithKey(): Keygen activate (registers this machine, respects 3-machine limit)
  → download + cache signed license file for offline verification
  → onDidChangeEntitlement → Pro unlocks immediately, no restart
```

**Air-gapped / enterprise (no network on the dev machine):**
```
"FlightPath: Activate Offline (Air-Gapped) License"
  → user obtains a signed license file on a connected device (Keygen portal/admin),
    transfers via USB or QR
  → import via file picker or paste, or "Scan QR" for fully offline transfer
  → importLicenseFile(): verify Ed25519 signature + expiry OFFLINE with embedded public key
  → cache + unlock; zero network calls
```

Add **"FlightPath: Deactivate Pro License"** and a Free/Pro status surface (status bar / footer). Reference Keygen's [air-gapped activation example](https://github.com/keygen-sh/air-gapped-activation-example) for the QR/USB machine-file flow.

### 1.6 Tier Structure

> **Gating philosophy: gate by _reach_, not by _limits_.** No step caps, no workflow-count caps, no concurrency caps — usage limits feel punitive, are trivially circumvented (split the workflow), and generate bad launch reviews. The entire **local** product is free and fully functional. Pro unlocks the one capability with the highest willingness-to-pay and the highest support cost: **using FlightPath remotely / on the go.**

**The key split — the hosted dashboard server, gated by reach:**

- **Free — localhost only (`127.0.0.1`):** anyone can open the browser dashboard on the same machine and experience it for real.
- **Pro — remote / LAN / on-the-go:** binding to `0.0.0.0`, the LAN IP selector, QR-to-phone, and HTTPS-for-mobile-push in `ServerSection.tsx`. This is the "code from anywhere" magic — the part that costs the most to support and is hardest to replicate.

| Capability | Free | Pro |
| ---------- | ---- | --- |
| All 7 harnesses | ✅ | ✅ |
| Core workflow execution (YAML/JSON/MD), **unlimited steps** | ✅ | ✅ |
| End conditions, pre-conditions, error/retry behavior | ✅ | ✅ |
| VS Code dashboard | ✅ | ✅ |
| Completion / hook notifications | ✅ | ✅ |
| MCP manager + MCP server integration | ✅ | ✅ |
| Agent & Skills manager | ✅ | ✅ |
| AI commit message generation | ✅ | ✅ |
| CLI binary, templates, output history | ✅ | ✅ |
| **Hosted dashboard — localhost (`127.0.0.1`)** | ✅ | ✅ |
| **Hosted dashboard — remote / LAN / on-the-go** (`0.0.0.0`, LAN IP, QR-to-phone, mobile-push HTTPS) | ⏱️ trial | ✅ |
| **Custom hooks** (user-defined pre/post execution) | ❌ | ✅ |
| **Air-gapped / offline activation** (enterprise) | ❌ | ✅ |
| Custom icon color (cosmetic "thank-you" perk) | ❌ | ✅ |
| All future Pro features | ❌ | ✅ |

**Remote-access trial.** New users get a **14-day, full-featured trial of remote access** — no card, no account — so they can taste coding on the go before deciding. When it lapses, the server keeps running on **localhost for free**; remote binding shows a friendly upsell. The trial start timestamp lives in `globalState`; it flows through the same `LicenseService`, so an activated license simply supersedes the trial.

### 1.7 Pricing

- **Perpetual, one-time** — matches VS Code-extension buyer expectations; lowest support/churn.
- Target **$59 USD** one-time (validate against comparable extensions).
- Activates on up to **3 machines** (enforced by Keygen machine limits, not LS).
- Subscription "Pro+" / Teams is a Phase-2 concern (roadmap 4.2), not launch.

### 1.7.1 Enterprise SKU (self-serve site license)

Design goal: **a one-person company must not be answering enterprise sales emails.** The Enterprise SKU is therefore **self-serve and auto-fulfilled by the same pipeline**, not a "contact us" funnel.

- **Product:** a second Lemon Squeezy product — **FlightPath Enterprise**, an **annual subscription**, flat price for **unlimited internal seats** (a site license). Individual Pro stays **perpetual**; Enterprise is **annual** because enterprises budget yearly and the recurring revenue + SLA justify it.
- **Fulfillment — identical webhook → Keygen path.** The Netlify function routes by LS `product_id`/`variant_id` to a Keygen **Enterprise policy** with **unlimited machine activations** and an **annual expiry**. Purchase → license auto-issued → key delivered. **Zero email.** "Unlimited seats" is one field on the Keygen policy.
- **Renewals / cancellation:** the webhook also handles LS subscription events (`subscription_payment_success` → extend the Keygen license expiry; `subscription_cancelled` / `subscription_expired` → let it lapse). LS handles recurring billing + tax automatically.
- **Price for self-serve:** target **~$2k–$5k/yr** — within corporate-card range so it clears without procurement. Above ~$10k, buyers expect POs/sales; staying under keeps it zero-touch.
- **Self-serve legal:** publish **click-through** Terms + a standard **DPA** + a **trust/security page** so legal teams can self-serve their review without a custom MSA. This removes the most common reason an enterprise purchase stalls.

**What stays manual (kept rare by design):** the subset of enterprises that *require* a PO/invoice/net-terms or a signed custom MSA/DPA/security questionnaire cannot be fully automated. Mitigate by (a) pricing within corporate-card range, (b) the click-through legal + DPA + trust page above, and (c) a single **"Need an invoice or PO? email sales@flightpath.dev"** fallback — and even those invoices can be issued semi-automatically via LS/Stripe. Most mid-market buys never touch the inbox.

**Open choice — flat vs. size-tiered:** a single **flat unlimited** site license is simplest and fully zero-touch (recommended at launch); **size-tiered** enterprise pricing (≤500 / ≤2,000 / unlimited devs) captures more from the largest orgs but adds checkout complexity and edges toward "talk to sales." Add tiers later if data warrants.

### 1.8 Gating points in code

Gate each Pro capability through `await licenseService.isPro(context)` (or a feature/trial check). The server is gated **by bind reach, not by startup** — localhost always works free. Known sites (verify exact class names during implementation):

- **Remote bind** — `src/server/**`: allow `127.0.0.1`/loopback unconditionally; gate `bindAddress: "0.0.0.0"` (and any non-loopback bind) behind Pro/trial. When unlicensed, fall back to localhost and surface an upsell rather than failing.
- **Remote-only UI affordances** in `ServerSection.tsx`: LAN IP selector, QR-to-phone, mobile-push/HTTPS-for-remote flows — disabled with upsell when not Pro/trial.
- **Custom hooks** — the user-defined `ExecutionProperties.hooks` execution path (harness command building). FlightPath's own internal completion/notification hooks are **not** affected.
- **Air-gapped activation command** — offline activation is itself a Pro capability.
- **Custom icon color** — `server.iconBgColor` / `server.iconFgColor` writes in `ServerSection.tsx` — Pro perk.

Each blocked gate shows a friendly upsell linking to `flightpath.dev/pricing/` — never a silent failure. **Free stays genuinely free:** notifications, the MCP manager + integration, the agent/skills manager, AI commit messages, the CLI, and the entire local dashboard are never gated.

### 1.9 Website / docs coupling

The pricing page, LS checkout link, and customer portal live on `flightpath.dev` ([`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md) Phase 6). This plan owns extension-side activation, verification, gating, **and the Netlify webhook function**. `docs/pro/index.md` documents both the online and air-gapped activation steps.

---

## Phase 2 — Accounts & Sign-In (later)

Triggered when the **hosted dashboard becomes a paid cloud product** (server identity genuinely required):

- Add `activateWithSignIn()` using the **VS Code authentication provider** API + an **OAuth 2.0 device-code** flow.
- Entitlement is fetched by identity instead of pasted key — but it resolves to the **same Keygen license + same offline verification path**, so gate sites are unchanged.
- Website gains sign-up/sign-in via **managed auth** (Clerk / Supabase / WorkOS) — never hand-rolled.
- Keys/files and sign-in coexist; existing customers keep working.

Nothing in Phase 1 hardcodes "key" assumptions outside `activateWithKey()` / `importLicenseFile()`.

---

## Implementation Order (Phase 1)

0. Complete Phase 0 business email and account ownership setup in [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md): `support@flightpath.dev`, vendor owner emails, GitHub/publisher identity, and DNS/email authentication.
1. `LicenseService` interface + `Entitlement` type + `PRO_FEATURES` constants (`DashboardConstants.ts`).
2. **Keygen** account: product, perpetual-Pro **Policy** (Ed25519, encrypted files, 3-machine limit); copy the **account public key** into the extension build config.
3. **Lemon Squeezy** product **FlightPath Pro** (perpetual, $59); webhook → Netlify; HMAC secret in Netlify env.
4. **Netlify Function** `ls-webhook`: verify LS signature, create Keygen license (idempotent on order ID), deliver key; handle refund → revoke.
5. Extension: `activateWithKey()` (online activate + cache signed file), offline `getEntitlement()` verify (Ed25519 + expiry), `refresh()`, offline-grace logic.
6. Extension: `importLicenseFile()` + **"Activate Offline (Air-Gapped) License"** command (file/paste + optional QR).
7. Commands "Activate / Deactivate Pro License", Free/Pro status surface, `onDidChangeEntitlement` live UI refresh.
8. Gate Pro capabilities (§1.8) behind `isPro()` with upsell messaging.
9. Remote-access **trial**: 14-day timer in `globalState`; remote bind + remote UI allowed during the trial; upsell on lapse; license supersedes trial.
10. Production-build verification of the **unlicensed** path (roadmap Tier 0.2).
11. `docs/pro/index.md` (online + air-gapped activation); pricing-page wiring with `LANDING_PAGE_PLAN.md`.
12. **Replace `LICENSE`** (ELv2 → custom commercial EULA, lawyer-reviewed); wire `package.json` license field, `flightpath.dev/terms`, README + Marketplace blurb; stand up the `support@flightpath.dev` inbox.
13. **Enterprise SKU (self-serve):** second LS product (annual subscription); Keygen Enterprise policy (unlimited activations, annual expiry); webhook routing by `product_id` + LS subscription-event handling (renew/extend, cancel/lapse); publish click-through Terms + DPA + trust page; `sales@flightpath.dev` PO fallback.

---

## Verification Plan

- `getEntitlement()` accepts a validly Ed25519-signed Keygen license file and rejects a tampered/expired one — **offline, no network**.
- Online activation: valid key → machine registered (≤3) → signed file cached in `SecretStorage`; invalid key → clear error, stays free.
- Air-gapped: `importLicenseFile()` verifies and unlocks with **no** network calls; corrupt/foreign-signed file → rejected.
- Offline grace: expired file + no network → honored within window, downgraded after.
- Fail-open: corrupt cache / verification throw → free tier, no crash, non-blocking notice.
- Webhook: LS `order_created` → exactly one Keygen license (idempotent on retry); `refund` → license revoked.
- Each gate: capability available when `isPro()` true, upsell when false; air-gapped command itself is Pro-gated.
- **Server reach:** localhost bind works with no license; remote bind (`0.0.0.0`) is blocked → falls back to localhost + upsell when not Pro/trial; allowed during an active trial and with Pro.
- **Trial:** a fresh install gets remote access for the trial window; after expiry remote is gated but localhost still works; activating a license supersedes the trial.
- Free path: full production VSIX with **no** license never blocks core workflow execution, notifications, MCP, agent/skills, or commit messages.

---

## Open Questions

1. ~~**Remote-access trial:** length/scope.~~ **Resolved:** 14-day full remote, **unlimited devices**. No per-device tracking (it would be easy to game by auto-deactivating, and adds complexity for little gain).
2. **Price point:** validate $59 one-time against comparable paid VS Code extensions.
3. **Offline file TTL:** consumer online files (short TTL, auto-refresh) vs. enterprise air-gapped files (long-lived / per-contract). Pick defaults.
4. **Key delivery:** LS custom fulfillment showing the Keygen key vs. our own transactional email from the Netlify function. Which is simpler with the LS account you have?
5. **Keygen plan:** hosted Keygen Cloud tier vs. self-hosted edition — confirm current pricing and pick.
6. ~~**Enterprise SKU.**~~ **Resolved:** self-serve, auto-fulfilled **annual unlimited-seat site license** (~$2k–$5k/yr), same LS→Keygen pipeline. **Flat unlimited** at launch (size tiers deferred). Manual PO/MSA path kept rare by design. See [§1.7.1](#171-enterprise-sku-self-serve-site-license).
7. ~~**EULA threshold number.**~~ **Resolved:** **$10M revenue / 250 employees** (Docker's line). Confirm with the lawyer at drafting.
8. **Lawyer:** engage an attorney to draft/review the custom EULA (and the click-through Terms + DPA) before launch.

---

## What Not To Build Yet

- Custom auth / user-account database / password management (Phase 2 uses managed auth only).
- Hand-rolled signing/crypto (use Keygen's signed license files + official verification examples).
- Per-request phone-home validation (offline signed files are the source of truth).
- Subscription billing, Teams seats, usage metering (post-launch, data-driven).
- Server-side enforcement of local gates (verification is client-side by design; threat model is honest paying users, not determined crackers).

---

## Related Documents

- [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md) — website, pricing page, LS checkout, Netlify deploy (hosts the webhook function)
- [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) — top-level launch sequence, business email, vendor ownership, legal, and support readiness
- [`../active/DOCUMENTATION_STRATEGY_PLAN.md`](../active/DOCUMENTATION_STRATEGY_PLAN.md) — docs site (`docs/pro/index.md`)
- [`TELEMETRY_PLAN.md`](TELEMETRY_PLAN.md) — usage data to tune tiers/pricing post-launch
- [`ROADMAP.md`](ROADMAP.md) — items 0.B and 4.2
- Keygen: [offline cryptography](https://keygen.sh/docs/api/cryptography/) · [offline licensing model](https://keygen.sh/docs/choosing-a-licensing-model/offline-licenses/) · [air-gapped activation example](https://github.com/keygen-sh/air-gapped-activation-example) · [hybrid online/offline example](https://github.com/keygen-sh/example-csharp-hybrid-online-offline-licensing)
