# CLA intake script

[`Code.gs`](Code.gs) is a Google Apps Script that runs Contributor License Agreement
acceptance by email ([Privacy Policy §3.6](https://ctrlyoke.dev/privacy/#36-contributions-and-contributor-license-agreement-records),
approved in [the v1.8 memo](../../dev/implemented/PRIVACY_1.8_LAWYER_REVIEW.md#2-replace-hosted-signing-with-acceptance-by-email)).
It runs in Fuzzy Nova's Google Workspace account, every five minutes:

1. **Open PRs.** For the PR author and every commit author, it checks the acceptance Sheet
   by GitHub user ID, so a contributor who has already accepted passes without being asked
   again, even after a username change. It sets the `cla` commit status to success or
   pending. For anyone who hasn't accepted, it comments once with a link that opens a
   pre-filled acceptance email.
2. **Acceptance emails** to `licensing@ctrlyoke.dev`. It reads the CLA version, PR link and
   username, then checks that the user exists, is the author or a commit author of that PR,
   and that Gmail authenticated the sender. It records a row in the Sheet.
3. **Confirmation.** A row becomes `accepted` once the contributor has commented on the PR.
   The next run then sets the status to success.

The Sheet is the record of who accepted. Email addresses and entity names stay in it and in
Gmail, never in GitHub. GitHub only receives usernames, which the PR already shows.

## What needs a person

The script labels the email `CLA/needs-review` and emails you when:

- the acceptance is for an entity (check the signer's authority);
- the email names a different CLA version, an unknown user, a PR they aren't on, or is
  missing the acceptance statement;
- Gmail could not authenticate the sender (DMARC, or DKIM and SPF).

Check it, then set the row's **Status** to `accepted` or `rejected`, and fill in **GitHub
user ID** if it's empty (`https://api.github.com/users/<login>` shows it). The next run
picks the change up.

A PR stays pending when a commit's author email isn't linked to a GitHub account. Ask the
contributor to fix the commit author, or, once you've checked who wrote it, add the
`cla-verified` label to the PR.

## Setup

1. **GitHub token.** Create a fine-grained personal access token on the maintainer account,
   limited to `FuzzyNova/ctrlyoke`, with **Commit statuses: Read and write**, **Pull
   requests: Read and write** and **Issues: Read and write** (PR comments use the issues
   API). Set it to expire, and note the date in `dev/active/RELEASE_CHECKLIST.md`.
2. **Sheet.** Signed in as the Workspace account that receives `licensing@` mail (it reads
   that Gmail), create a private Sheet named `ctrlyoke CLA acceptances` in the Fuzzy Nova
   Drive folder `Contracts & Agreements/Contributor License Agreements/`. Don't share it.
3. **Script.** In the Sheet, open **Extensions → Apps Script**, replace `Code.gs` with this
   folder's `Code.gs`, and save. Under **Project Settings → Script properties**, add
   `GITHUB_TOKEN`, and set the time zone to yours.
4. **Run `setup`** from the editor once and grant the permissions it asks for (Gmail,
   Sheets, external requests, triggers and sending email). It creates the `Acceptances`
   tab, both Gmail labels, and the five-minute trigger.
5. **Label.** Create a `cla-verified` label in the GitHub repository.
6. **Test** with the test account: open a fork PR, wait for the request comment, send the
   pre-filled email, reply on the PR, and check that `cla` turns green.
7. **Require it.** In the `main` ruleset's required status checks, add `cla`.

## Changing it

The deployed copy lives in Apps Script, so after changing `Code.gs` here, paste it into the
editor again. When the CLA version changes, update `claVersion` and `claUrl` in `CONFIG`.
Only acceptances of the current version count, so every contributor is asked to accept the
new version on their next PR. Confirm with counsel that this is what you want first. The
script never deletes rows or emails. Retention follows Privacy Policy §8, reviewed yearly.
