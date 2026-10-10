# Pro License Followups

**Created:** September 15, 2026
**Status:** Backlog.
**Split from:** [`../implemented/PRO_LICENSE_MANAGEMENT_UX_PLAN.md`](../implemented/PRO_LICENSE_MANAGEMENT_UX_PLAN.md)
(that plan is fully implemented; this doc captures the genuinely open items
found during the 2026-09-15 verification pass).

---

## 1. "Unlock Pro Features" CTA is narrower than spec'd

The implemented CTA lives inline at the top of `ServerSection.tsx`
(`!licenseAccess.isPro` gated, navigates to the License tab) rather than as
an always-visible button in `GlobalSettingsDrawer`'s title bar. It's only
seen by a user already on the Server tab. Consider either:

- Promoting it to the drawer title bar as originally spec'd (visible from
  every tab), or
- Deciding the current placement is good enough and closing this out.

Low priority — the Server tab is the primary place non-Pro users hit gating
today, so the current placement already covers the main path.

Decided 10/10/2026: the current placement is good enough, moving to implemented.

## 2. Deferred non-goals from the original plan

Carried forward as still-future work, not started:

- **Phase 2 sign-in/device-code activation** (`activateWithSignIn`) —
  tracked originally in `PRO_LICENSE_PLAN.md` §Phase 2. No code exists for
  this; email/password or device-code license activation is still
  key-paste/offline-file only.
- **Option C of the self-serve offline license work** — a "generate a license
  file for another machine" action inside `LicenseSection.tsx`, reusing the
  client-side Keygen checkout now proven by the shipped
  [`../implemented/SELF_SERVE_OFFLINE_LICENSE_FILE_PLAN.md`](../implemented/SELF_SERVE_OFFLINE_LICENSE_FILE_PLAN.md)
  page. Deliberately deferred: it only helps someone already running Pro on a
  connected machine, which the ctrlyoke.dev page already covers more broadly.
- **General Keygen account/admin UI** — out of scope by design; machine
  management stays scoped to the current license via
  `LicenseService.listMachines`/`deactivateMachine`, not a broader account
  view.

## 3. Untracked polish

- No automated test currently asserts the `ServerSection` CTA disappears
  when `licenseAccess.isPro` is true (the original plan's React test list
  called for this against the drawer header; it should be re-targeted at
  `ServerSection.test.tsx` given the actual implementation location).
