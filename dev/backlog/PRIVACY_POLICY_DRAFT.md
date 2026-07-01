# FlightPath Privacy Policy — DRAFT

> **DRAFT — requires attorney review before publishing. Not final legal text.**
> Companion to [`LICENSE_DRAFT.md`](LICENSE_DRAFT.md) — please finalize both together.
> See the questions for counsel at the bottom, and the "Data Collection & Privacy"
> questions in `LICENSE_DRAFT.md`.

**Controller:** Fuzzy Nova ("Fuzzy Nova", "we", "us", "our")
**Product:** FlightPath VS Code extension and companion CLI / MCP server binaries
**Effective date:** [DATE]
**Draft version:** 0.1 — June 2026

---

## Plain-Language Summary _(not part of the policy)_

- FlightPath runs locally in your editor. **We never collect your prompts, code, file paths, workspace names, or AI output.**
- If you buy **Pro**, we process the minimum data needed to sell you a license and verify it (your email and payment details via our payment provider; a machine identifier and license key to activate Pro on your computer).
- FlightPath sends **anonymous usage telemetry** (which harness you used, step counts, durations, error types) to help us improve the product. It contains no personal content and **respects your VS Code `telemetry.telemetryLevel` setting** — turn it off there and we stop receiving it.
- We use a small set of trusted vendors (payments, license verification, telemetry, website hosting, support email) and we don't sell your data.
- You can contact us at `privacy@flightpath.dev` to access or delete your data.

---

## 1. Scope

This policy explains what data Fuzzy Nova collects when you use the FlightPath VS Code extension and companion binaries (the "Software"), the FlightPath website at `flightpath.dev`, and our support channels. It does not cover third-party AI services (GitHub Copilot, Claude, Codex, Gemini, and others) that you connect to through the Software — your use of those services is governed by their own privacy policies.

---

## 2. What We Do _Not_ Collect

The Software runs locally and orchestrates AI coding harnesses on your own machine. We have designed it so that the following **never leave your machine to us**:

- Prompt text or workflow content
- Source code, file contents, file paths, or workspace/repository names
- AI model output or response text
- Session IDs, run IDs, or other workflow identifiers
- Agent names, skill names, MCP server IDs, or end-condition script names
- Any other user-generated string

---

## 3. Data We Process

### 3.1 Anonymous Usage Telemetry _(lawful basis: consent / legitimate interest — see §6)_

The Software uses Microsoft's `@vscode/extension-telemetry` library, which **honors your VS Code `telemetry.telemetryLevel` setting**. If you have telemetry disabled in VS Code, the Software sends us nothing.

When enabled, we collect only non-identifying operational data, such as:

- Harness identifier (e.g. which AI CLI was used) and execution mode
- Counts and durations (step counts, elapsed time, token counts)
- Boolean feature flags (whether a feature was enabled)
- Outcome and error _type_ names (never error messages, which may contain user data)
- Standard environment metadata automatically added by the library: a VS Code machine identifier, extension version, VS Code version, and OS platform

We use this to understand which features and harnesses are used, prioritize fixes, and decide where to invest. Telemetry is processed by **Azure Application Insights** (Microsoft).

### 3.2 Pro License & Activation Data _(lawful basis: performance of a contract)_

If you purchase and activate a Pro license, we process the minimum data needed to issue and verify it:

- **License key** and **license status**
- A **machine fingerprint/identifier** and **IP address** used to enforce the per-license machine limit during online activation, refresh, and deactivation

License verification is provided by **Keygen**. Where you use the **offline signed-license file**, activation is verified locally on your machine and this data is **not** transmitted to us or Keygen.

### 3.3 Purchase & Billing Data _(lawful basis: performance of a contract / legal obligation)_

Purchases are handled by our payment provider, **Lemon Squeezy** (acting as merchant of record). They collect and process your name, email address, billing country, and payment details under their own privacy policy. We receive order metadata (such as your email, product, and order ID) to issue and support your license. We do not receive or store full payment-card numbers.

### 3.4 Support Data _(lawful basis: legitimate interest)_

If you email `support@flightpath.dev`, `billing@flightpath.dev`, `security@flightpath.dev`, or `sales@flightpath.dev`, we receive the contents of your message and your email address. Support email is hosted on **Google Workspace**. Public bug reports filed on our GitHub repository are governed by GitHub's privacy policy and are visible to anyone.

### 3.5 Website Data _(lawful basis: legitimate interest)_

The `flightpath.dev` website and its checkout/license functions are hosted on **Netlify**, which processes standard server logs (including IP addresses) to serve and secure the site.

---

## 4. Sub-Processors

We rely on the following vendors to operate FlightPath. Each processes data only as needed to provide its service:

| Sub-processor                        | Purpose                             | Data categories                                              |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------ |
| Microsoft Azure Application Insights | Anonymous usage telemetry           | Telemetry events, machine/version/OS metadata                |
| Keygen                               | Pro license issuance & verification | License key, machine identifier, IP (online activation only) |
| Lemon Squeezy                        | Payments & merchant of record       | Name, email, billing country, payment metadata               |
| Netlify                              | Website & license webhook hosting   | Server logs, IP addresses                                    |
| Google Workspace                     | Business & support email            | Email content and addresses                                  |

---

## 5. How We Use Data

- To provide, activate, and verify Pro licenses you purchase
- To process payments and issue receipts
- To respond to support, billing, and security inquiries
- To understand aggregate, anonymous usage and improve the Software
- To detect and prevent fraud, abuse, and license-term violations
- To comply with legal obligations

We **do not sell your personal data**, and we do not use it for third-party advertising.

---

## 6. Your Choices and Rights

- **Telemetry opt-out:** set `telemetry.telemetryLevel` to `off` in VS Code, or use only the Free Tier. This stops all telemetry to us.
- **Access / deletion / correction:** depending on your location (e.g. GDPR, UK GDPR, CCPA/CPRA), you may request access to, correction of, or deletion of your personal data, and may object to certain processing. Contact `privacy@flightpath.dev`. Because some data lives with our sub-processors, fulfilling a request may require us to coordinate with them.
- **Do Not Sell or Share:** we do not sell or share your personal data as defined by the CCPA/CPRA.

---

## 7. Data Retention

- **Telemetry:** retained per Azure Application Insights configuration (currently 90 days).
- **License & activation records:** retained by Keygen for the life of the license and as needed to support and enforce it.
- **Purchase records:** retained by Lemon Squeezy and by us as required for tax, accounting, and legal obligations.
- **Support email:** retained as needed to resolve and reference inquiries.

---

## 8. International Transfers

Our sub-processors may process data in the United States and other countries. Where required, transfers rely on appropriate safeguards such as Standard Contractual Clauses. _[ATTORNEY TO CONFIRM mechanism and any required disclosures.]_

---

## 9. Children

FlightPath is a professional developer tool and is not directed to children. We do not knowingly collect personal data from children under [16/13 — align with EULA]. _[ATTORNEY TO CONFIRM age and consistency with EULA #11.]_

---

## 10. Changes to This Policy

We may update this policy from time to time. Material changes will be reflected by updating the effective date above and, where appropriate, noted on `flightpath.dev`.

---

## 11. Contact

Privacy inquiries: `privacy@flightpath.dev`
Business operator: Fuzzy Nova — `admin@fuzzno.com`

---

## Questions for Counsel

These mirror and extend the "Data Collection & Privacy" questions in [`LICENSE_DRAFT.md`](LICENSE_DRAFT.md):

1. **Controller/processor roles** — confirm Fuzzy Nova is the controller for telemetry, license, and support data, and clarify roles where Lemon Squeezy acts as merchant of record (§3.3).
2. **Lawful basis for telemetry** — is honoring VS Code's `telemetry.telemetryLevel` sufficient consent under GDPR/ePrivacy, or is an additional in-app notice/opt-in required? (§3.1, §6)
3. **"Anonymous" vs. "pseudonymous"** — given the auto-attached VS Code machine ID and version/OS metadata, advise the defensible term throughout this policy and in marketplace copy.
4. **Offline-first license framing** — confirm it is accurate and advantageous to state that the offline signed-license path transmits no activation data (§3.2).
5. **Sub-processor list** — must this be named (as in §4) or may it be described by category? Which vendors require a signed DPA on our side?
6. **International transfers** — confirm the SCC/appropriate-safeguards language in §8 and any region-specific additions (UK IDTA, Swiss addendum).
7. **CCPA/CPRA** — confirm the "do not sell or share" statement and whether sub-processor sharing triggers any additional notice (§6).
8. **Retention windows** — confirm we can publish the specific windows in §7 and that they match our sub-processor agreements.
9. **Children's age threshold** — set the correct age and align with EULA #11 (§9).
10. **Acceptance & versioning** — should the privacy policy be referenced from the EULA and from a first-run notice? Coordinate with EULA #9 (first-run acceptance).
11. **Launch gating** — confirm this policy must be live before _any_ purchase-metadata or telemetry collection begins (RELEASE_CHECKLIST Phase 5).
