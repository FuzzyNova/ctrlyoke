# Final Release Prep

**Created:** 2026-10-17, from a release-readiness audit run just before the repo-public flip and
the `LAUNCHED` toggle. Eight auditors (backlog, repo hygiene, legal/metadata, build/CI, code
sanity, docs, landing/launch mechanics, checklist and GitHub settings) ran in parallel, and a
separate verifier re-checked every blocker or high finding.

**Scope:** a sanity check, not a security audit (the secret scan and security review were already
done; see `RELEASE_CHECKLIST.md` Phase 14). It tracks the recommendations. Real defects are filed
one per file under `dev/bugs/backlog/` and linked below. `dev/active/RELEASE_CHECKLIST.md` is still
the canonical go-live tracker. When an item here is done, tick it, and fold any lasting process
change into the checklist.

## Verdict

- **Healthy:** typecheck, lint, `check:docs` and compile all pass. `npm audit --omit=dev` finds 0
  vulnerabilities. `npm test` passes all three suites (extension 6603 passing, UI 3974,
  packaging 117).
- **Clean:** no tracked build artifacts, `.vsix`, `.env` or logs, now or in history. The workflows
  are safe for a public repo (no `pull_request_target`, read-only default token, no self-hosted
  runners).
- **Docs:** good enough. All 41 commands, 67 CLI flags, 13 MCP tools and six harness pages are
  covered, and 844 internal links resolve.
- **Backlog:** nothing in `dev/backlog/` must land before release. The 2026-10-10 compatibility
  triage still holds, and every plan added since is additive.
- **The one blocker** (test-mode checkouts minting real licenses, item 1) was mitigated in the LS
  dashboard on 2026-10-17; only the defensive code fix remains.

## Handoff: who does what

**Owner only** (dashboards, accounts, legal judgment). An agent cannot do these:

- Everything in "Go-live order" and "Right after the flip".

**Agent-ready now:** items 1 (code half), 3, 4, 6, 7, 8, 9, 10, 12, 13, 14, 15, plus "Docs" and
"Checklist housekeeping". The repo-wide format pass already landed (`f9c5fe317`), so agents can
run in parallel. Item 11 waits for release day. Every owner decision is made; nothing here needs
Nathan before work starts.

**Sequencing note (orchestrator, 2026-10-17):** agents work in the `bug-fix` worktree and do not
push, so two steps happen only after Nathan merges this work to `main`: the item 1 redeploy
(`workflow_dispatch` of `deploy.yml`, or the push itself once item 9 has put `netlify/**` in the
filter) and item 3 (running `ci.yml` and full-suite). Running `ci.yml` before the merge would not
exercise the `format:check` gate that item 7 adds, so item 3 is effectively owner-run after merge.

## Before the repo flip

- [ ] **1. Test-mode orders mint production licenses (was BLOCKER; mitigated).** Bug:
      [`test-mode-lemon-squeezy-orders-mint-production-licenses.md`](../bugs/backlog/test-mode-lemon-squeezy-orders-mint-production-licenses.md).
      The test checkout URLs are in `src/license/LemonSqueezyConstants.ts` (and in git history).
      `ls-webhook.ts` maps the test variants to the production Keygen policies and never checks
      `test_mode`. Once the repo is public, anyone can get free Pro or Enterprise with Stripe's test
      card.
  - [x] **Dashboard half, done by Nathan 2026-10-17.** Test webhook `129600` deleted; test-mode
        Pro and Enterprise products unpublished, so the committed test checkout links are dead; live
        webhook `143280` untouched. Test-issued Keygen licenses revoked. The one remaining license
        is Nathan's development key, so keep it. The hole is closed today.
  - [ ] **Code half (agent):** in `ls-webhook.ts`, skip issuance for `meta.test_mode === true`
        unless an env flag such as `ALLOW_TEST_MODE_ORDERS` is set. This guards against a test
        webhook being re-created later. Cover it with a unit test; there is no test webhook to verify
        against live anymore. Redeploy with `workflow_dispatch` (`netlify/**` is outside the push
        filter, unless item 9 lands first). Update the comment "Both modes are mapped so test-mode
        purchases keep working after launch" to match.
- [x] **2. Decided 2026-10-17: accept storefront sales before DataRep is effective.**
      `ctrlyoke.lemonsqueezy.com` lists Pro at $59 with a live checkout, and the live Enterprise URL
      is in the deployed `/enterprise/checkout/` page source. So `LAUNCHED` is not the only purchase
      gate (checklist ~L551), and EU/UK buyers can pay before DataRep is effective (checklist
      ~L722). Nathan accepts the window of a few days: DataRep was purchased 2026-10-16, nothing is
      announced, and LS is merchant of record. The storefront stays on. Still hold the public
      Marketplace listing and the `LAUNCHED` flip until the appointment is confirmed, since those
      are what actually offer the product to the EU/UK. Housekeeping: reword checklist L551 and
      L722 to match.
- [ ] **3. Run `ci.yml` once on GitHub.** The future required check `fast-checks` has never run
      (`gh run list --workflow ci.yml` is empty). Run `gh workflow run ci.yml --ref main`, and run
      full-suite again too (last green 2026-10-13). Confirm both are green before applying the
      rulesets.
- [ ] **4. Personal data cleanup (decided 2026-10-17: remove all of it).**
  - Bug: [`status-line-preview-hardcodes-personal-path.md`](../bugs/backlog/status-line-preview-hardcodes-personal-path.md).
    `C:\Users\natha\...` ships in the Settings UI.
  - Remove every personal or real-looking email address:
    - Redact the personal Gmail in `dev/reference/TUI_VISUALS.md:159`.
    - Replace the `nathan@gmail.com` examples (likely a real stranger's address) in
      `docs/workflows/context-files.md:19`, `src/utils/ReferenceBoundary.ts:8`,
      `src/utils/FileReferenceParser.ts:728` and `src/test/unit/ReferencePatterns.test.ts:84` with
      `name@example.com`.
    - Before finishing, run `git grep -nE "[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud)\.com"`
      and clean up anything else it finds.
    - Keep the deliberate `@ctrlyoke.dev` role addresses and `@example.com` placeholders.
  - [x] The favoriteColor test skill no longer names Felix or Meekah (done 2026-10-17). Git history
        still holds the old text. `Felix/M` in `src/ui/webview-react/static/dictionaries/en_US/en_US.dic`
        is a standard spell-check dictionary entry, so leave it.
- [x] **5. Sensitive-but-not-secret docs (done 2026-10-17).**
  - `REFUND_POLICY.md` is trimmed (no step-by-step abuse method, no "at Nathan's discretion"), all of
    its steps are complete (partial refund confirmed by Nathan), and it has moved to
    `dev/implemented/`. Checklist L765 is ticked.
  - `rebrand-naming.md` and `trademark-search-results.csv` moved to the Fuzzy Nova LLC business
    Drive (`Trademark & IP/`) and were removed from `dev/reference/`. Git history still holds them,
    which is acceptable.
- [ ] **6. Repo tidy (trivial):**
  - Untrack `ctrlyoke-fuzzno.code-workspace` (it references a private sibling repo) and add it to
    `.gitignore`.
  - Add `.env.*` with `!.env.example` to `.gitignore`.
  - Delete or move the stale `.ctrlyoke/debug/*.md` handoffs (FlightPath-era, one marked
    `🔴 UNRESOLVED`).
- [ ] **7. Format drift.** The one-time `npm run format` landed in `f9c5fe317`. What's left: add
      `landing/.astro` to `.prettierignore`, and add `format:check` to `check:fast`, so the pre-push
      hook and `ci.yml` enforce it. Confirm `npm run format:check` exits 0 afterwards.

## Before tagging v0.2.0

- [ ] **8. Regenerate `THIRD_PARTY_NOTICES.md` (HIGH).** Bug:
      [`third-party-notices-stale-and-missing-epl-elkjs.md`](../bugs/backlog/third-party-notices-stale-and-missing-epl-elkjs.md).
      EPL-2.0 elkjs (via mermaid) ships in the VSIX without being disclosed. Eight direct runtime
      deps are missing, versions are stale and licence texts are absent. Rebuild the VSIX after.
      Default: **disclose** elkjs, rather than stripping the ELK layout engine out of mermaid,
      unless Nathan says otherwise.
- [ ] **9. Deploy filter.** Bug:
      [`deploy-path-filter-skips-root-legal-docs.md`](../bugs/backlog/deploy-path-filter-skips-root-legal-docs.md).
      The DataRep `PRIVACY.md` commit will not redeploy the site on its own. Fix the filter, or
      dispatch `deploy.yml` by hand and check `/privacy/`.
- [ ] **10. Small code bugs:**
  - [`web-push-vapid-subject-placeholder-email.md`](../bugs/backlog/web-push-vapid-subject-placeholder-email.md)
  - [`opencode-pretooluse-compat-matrix-overstates-blocking.md`](../bugs/backlog/opencode-pretooluse-compat-matrix-overstates-blocking.md):
    the public matrix promises that a preToolUse guard blocks on OpenCode, and it does not.
  - [`readme-logo-relative-image-path.md`](../bugs/backlog/readme-logo-relative-image-path.md)
- [ ] **11. Version strings.** Re-date `CHANGELOG.md` `[0.2.0]` (currently 2026-10-16). Bump the
      `ctrlyoke@0.1.2` pins in `docs/cli/ci.md` (L13, 19, 188, 200). Optionally inject the package
      version for `src/mcp-server.ts:434` (`"1.0.0"`) and `CodexAppServerClient.ts:132` (`"0.1.0"`).
- [ ] **12. Pricing copy vs EULA §6(c) (decided 2026-10-17; agent-ready).** The pricing page says
      "Perpetual … includes all future Pro features", while `LICENSE.md` §6(c) reserves a paid
      major-version upgrade. §6(c) opens with "Unless otherwise stated at purchase", so an unscoped
      "all future features" claim at purchase may override the reservation. **Decision:** keep
      §6(c) unchanged; the copy must not contradict it.
  - **Pricing cards and Pro feature marketing stay simple: "Pay once, use forever."** No caveats on
    the cards. Remove the unscoped claims at `landing/src/pages/pricing.astro:30` (the "All future
    Pro features" bullet) and `:137` ("Perpetual license. Includes all future Pro features."),
    replacing them with "Pay once, use forever" or similar. Do not add caveat bullets to the card.
  - **Details go in a short section below the pricing cards.** It also replaces the FAQ answer at
    `pricing.astro:41`. Plain language, a few sentences, covering:
    - The license never expires; you can keep using the version you bought forever.
    - Updates within your major version are included.
    - **Buying any `0.x` version includes `1.x`.**
    - We don't plan to charge for upgrades. If a future major version (e.g. `2.0`) is ever paid,
      the version you own keeps working.
  - `docs/pro/index.md:33` and `:60-61` also say "future Pro features": make them match the
    section above (Pro docs may carry the scoped wording directly).
  - Do not edit `LICENSE.md`.
- [ ] **13. Large-org threshold in the README (decided 2026-10-17).** The Marketplace listing stays
      **Free** to install: do not add a `"pricing"` field to `package.json`. Add one or two sentences
      to the README License section saying the free tier covers individuals and small teams, and
      that organizations with $10M+ revenue or 250+ staff need Pro (`LICENSE.md` §3(b)). Link
      `https://ctrlyoke.dev/docs/pro`.
- [ ] **14. README telemetry summary** (L363-368) understates `PRIVACY.md` §3: it leaves out the
      redacted error reports and pseudonymous machine/session IDs. Add them, or shorten the summary
      to just the link.
- [ ] **15. Marketplace discoverability:** add `opencode` and `qwen` to keywords. Consider the
      categories `["AI", "Machine Learning", "Other"]` (replacing "Programming Languages").

## Go-live order

This is consolidated from the landing and checklist auditors. The checklist never states the order
of the flip and the tag, and it has no step that makes the Marketplace listing public.

1. Fix items 1–3 (and whatever else from the list above you want in), then redeploy.
2. **Flip the repo public**, then run `apply-github-guardrails.mjs` (checklist ~L912/1088). Every
   GitHub link on ctrlyoke.dev (banner, nav, footer, docs edit links, npm metadata) 404s until this
   step.
3. DataRep email arrives: update `PRIVACY.md` (and `TRUST_PAGE.md`/`DPA.md` if needed), deploy
   (item 9), and check `/privacy/`.
4. Re-date the CHANGELOG, then push tag `v0.2.0`. Tagging after the flip is what gives the npm
   package provenance (`release.yml` ~L80).
5. Approve the npm stage. Check that `npm view ctrlyoke version` is `0.2.0` and that provenance
   shows.
6. **Make the Marketplace listing public** (add this checkbox to Phase 9). Check that the README
   images and CHANGELOG render. Confirm whether `vsce publish` flips visibility by itself.
7. Commit `LAUNCHED = true`. Check a live Pro checkout, and that `noindex` is gone on `/` and
   `/docs/`.
8. Take the trademark specimen screenshots (needs the public listing).

## Right after the flip

- [ ] Enable private vulnerability reporting, and confirm `TRUST_PAGE.md`'s `/security/policy` link
      resolves.
- [ ] Optional settings not covered by `apply-github-guardrails.mjs`: squash-only merges,
      auto-delete head branches, disable Projects, Dependabot security updates (consider
      versioning these in the script).
- [ ] Upload a social preview image (1280×640; none exists in `images/`).
- [ ] Throwaway fork PR test (checklist ~L1103).
- [ ] Update `full-suite.yml`'s "private-repo 2-vCPU runner" comment. Public repos get 4 vCPUs, so
      also reconsider the raised 60 s UI timeout.
- [ ] Pin `softprops/action-gh-release` to a SHA, and pin `netlify-cli@latest` and the `npm@^11`
      upgrade to exact versions. Both run in jobs that hold publish secrets.

## Docs (good enough; optional polish)

- [ ] `QUICK_START.md` ships in the VSIX but is a stale duplicate with repo-relative `docs/` links.
      Reduce it to a pointer at `ctrlyoke.dev/docs/guide/quick-start`, or switch to absolute URLs and
      add the `verboseLogging` caveat for the hook-debug log.
- [ ] `docs/examples/index.md` is thin (4 examples). Before launch if time allows, add mixed-harness
      implement/review, a parallel research group, a worktree run and an onPass retry loop.
- [ ] Add a sitemap (VitePress `sitemap.hostname`, plus `@astrojs/sitemap` or a static sitemap) and
      an `og:image`. `Layout.astro` declares `summary_large_image` but has no image.
- [ ] `DOCUMENTATION_GAPS_PLAN.md` P1 rows: a CLI "continuing and editing runs" walkthrough and
      `@image` attachments in `context-files.md`. Also mark its stale P0 mobile/Tailscale and §3.2
      rows done.

## Checklist housekeeping (`RELEASE_CHECKLIST.md`)

- [ ] Rewrite the L5 status header. It still says Phase 8 is the largest blocker and full-suite is
      failing.
- [ ] Summary row L1249: the Marketplace step now depends on DataRep and v0.2.0, not Phase 8.
- [ ] L551: name both purchase gates (the site and the LS storefront).
- [ ] L722: drop "set the real CHECKOUT_URL" (already live). Tick L766 and L1086 (0 issues/PRs
      verified).
- [ ] Phase 4.4 self-contradictions: storefront ON vs OFF (L146 vs L154), and "not yet
      deployed/verified" notes at L186, L278, L305, L424 and L506 that were superseded on Oct 16.
- [ ] Add the go-live order above and the "make Marketplace listing public" checkbox.
- [ ] Stale backlog headers: `SCREENSHOTS_AND_MEDIA_PLAN.md:37-39` and `WORKFLOW_STEP_PLAN.md:12-14`.
