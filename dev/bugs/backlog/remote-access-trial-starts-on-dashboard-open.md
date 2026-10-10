# Remote-access trial clock starts when the dashboard opens, not on first remote use

- **Found:** 2026-10-10 by backlog audit (DOCUMENTATION_GAPS_PLAN.md defect C12)
- **Area:** `src/license/LicenseService.ts`, `src/ui/DashboardApplication.ts`
- **Severity:** high

## Symptom

A new, unlicensed installation's 14-day remote-dashboard Evaluation Trial starts as soon as the
dashboard first asks for license state, even if the user never enables remote or LAN access.
A user who opens the local dashboard, then tries remote access three weeks later, finds the trial
already expired. This contradicts `LICENSE.md` §2(d): the trial begins "when that capability is
first used on that installation".

## Steps to Reproduce

1. Start from a fresh install with no license and no `REMOTE_ACCESS_TRIAL_START_KEY` in state.
2. Open the ctrlyoke dashboard (local webview only; leave `ctrlyoke.enableServer` off).
3. Look at the trial state: `REMOTE_ACCESS_TRIAL_START_KEY` is now set to the current time, and
   the license panel shows a trial end date 14 days out.

## Root Cause

`LicenseService.getRemoteAccessTrialStartedAt()` (`LicenseService.ts:823`) treats a missing stored
value as "now" and **persists** it. It runs on every read path: `getRemoteAccessTrialEndsAt()`
(`:320`) and the trial-active check behind `hasRemoteAccess()` (`:314`). The license-state
provider that `DashboardApplication` passes to `WebviewSettingsSync` (`DashboardApplication.ts:131-140`)
calls both whenever the dashboard pushes settings to the client, so a read starts the trial.

## Suggested Fix

Split reading from starting. Make `getRemoteAccessTrialStartedAt()` read-only, returning `null`
when there's no stored value. Add an explicit `startRemoteAccessTrial()` and call it only where
remote reach is actually first used (the hosted server binding a non-loopback address or accepting
its first non-localhost client). `getRemoteAccessTrialEndsAt()` should return `null`, meaning "not
started", until then, and the dashboard should show "14-day trial available". Fix this before
public launch: after launch, existing installs will already have a stored start time from a
dashboard open, and only a migration could tell those apart from real trial starts.
