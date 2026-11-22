# ctrlyoke Privacy Policy v1.8 review memo

**Prepared for outside counsel on behalf of Fuzzy Nova LLC · November 22, 2026**

[Open the complete v1.8 draft](PRIVACY_1.8_DRAFT.md) ·
[License v2.4 memo, CLA acceptance record](../implemented/LICENSE_2.4_LAWYER_REVIEW.md#cla-acceptance-record) ·
[Archived v1.7](https://ctrlyoke.dev/privacy/1.7/)

> **Approved by counsel and adopted November 22, 2026.** Counsel preferred email acceptance to hosted signing and approved recommendations 1–6 for that plan as written. The draft was adopted unchanged as `PRIVACY.md` v1.8 ([archived copy](../../legal/archive/privacy/1.8.md)), and Fuzzy Nova is removing the CLA Assistant integration. The remaining follow-ups are in `RELEASE_CHECKLIST.md`.

## Approval requested

> Do you approve the attached v1.8 draft and recommendations 1–6 below, including replacing hosted CLA Assistant signing with acceptance by email (item 2)? A single “approved” is enough. If any item needs a change, please identify its number and the wording or practice you would prefer.

## Background

Following the v2.4 memo, Fuzzy Nova set up the hosted CLA Assistant on November 22, 2026.
It presents the exact CLA v1.0 text from a dedicated GitHub Gist. A contributor signs in
with GitHub and signs. The `main` branch then requires CLA Assistant's `license/cla`
status before an outside PR can merge. The maintainer's account and `dependabot[bot]` are
exempt. Every PR also needs a code owner's review. CLA v1.0 itself is unchanged.

- **No outside contributor has signed.** The repository has had two pull requests from
  outside the maintainer account, PR #1 and PR #21. Both came from Fuzzy Nova's own test
  account. PR #21 tested CLA Assistant end to end, and that test account's signature is the
  only one CLA Assistant holds.
- **SAP SE runs cla-assistant.io as controller.** Its notice says SAP processes the signer's
  GitHub identity and associated email to keep signed agreements “available to the project
  owners”, stores the data on Azure in Europe, and uses EU Standard Contractual Clauses
  (SCCs) “if We transfer” data outside the EEA. [SAP Privacy Statement for CLA Assistant, reviewed revision](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30/9a01b923d6b60a0cce8a0568c6dc4fe3caafb5eb) ·
  [CLA Assistant storage documentation](https://github.com/cla-assistant/cla-assistant#where-is-the-list-of-signees-stored)
- **The owner dashboard and exports work as documented.** We checked them with the test
  signature. They show the GitHub username, repository, CLA title, Gist URL and revision,
  signing and revocation timestamps, and whether the agreement was linked at the GitHub
  organization level. They do not show email addresses. The Gist revision matched the
  [archived CLA v1.0](../../legal/archive/cla/1.0.md) exactly.

Privacy Policy v1.7 mentions GitHub only in its support section. The draft adds how Fuzzy
Nova handles contributions and CLA records under the email procedure recommended in item 2.

## Changes in v1.8

| Section | Change                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Scope adds contributing to the ctrlyoke repository.                                                                                      |
| 3.6     | Describes GitHub contribution data, CLA acceptance by email with a confirming PR comment, entity confirmations, and the records we keep. |
| 4       | Adds reviewing contributions and keeping CLA records as a use.                                                                           |
| 5       | Identifies the basis for administering an individual CLA, reviewing contributions, verifying entity authority, and keeping evidence.     |
| 6       | Adds contributor agreement email, and the data it contains, to the Google Workspace row.                                                 |
| 8       | Sets retention criteria and periodic review for CLA records.                                                                             |
| 9       | Says CLA records are handled from the U.S. and stored with Google Workspace.                                                             |
| 10      | Explains when Fuzzy Nova may keep CLA evidence after an erasure request.                                                                 |

The draft does not mention SAP or CLA Assistant. Item 2 explains why, and gives the text to
add if an outside signature reaches CLA Assistant before it is unlinked.

## Recommended answers

### 1. Approval of v1.8

Approve the attached draft for publication with the email procedure in item 2. Keep CLA
v1.0 unchanged. It requires affirmative acceptance and does not name a signing tool.

### 2. Replace hosted signing with acceptance by email

**Finding.** Continued hosted signing would involve a Chapter V transfer with no verified
transfer mechanism. Treat SAP as an independent controller for running the service and
Fuzzy Nova as controller for reviewing contributions and using the signature records. SAP's
notice and its control over hosting, authentication, service terms and retention support
that reading. Once an EU signer signs, SAP in Germany makes the record available to Fuzzy
Nova in Texas through the dashboard and exports. Under EDPB Guidelines 05/2021, viewing the
data on a screen is enough for a transfer when the three criteria are met. The GitHub
username, signing time and Gist revision identify the signer and their acceptance.
[EDPB Guidelines 05/2021, paragraphs 9 and 16](https://www.edpb.europa.eu/system/files/documents/2023-02/edpb_guidelines_05-2021_interplay_between_the_application_of_art3-chapter_v_of_the_gdpr_v2_en_0.pdf) ·
[EDPB guidance on controllers and processors](https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en)

We found no mechanism that covers this disclosure in public sources:

- SAP's published terms and GitHub App listing contain no SCCs or annex that binds
  repository owners or covers the dashboard and exports. SAP's general cloud DPA covers
  services in a customer agreement, and Fuzzy Nova has none for CLA Assistant.
  [CLA Assistant GitHub App](https://github.com/apps/cla-assistant) ·
  [SAP Cloud Services DPA, sections 1 and 2](https://assets.cdn.sap.com/agreements/data-processing-agreements/sps/data-processing-agreement-for-cloud-services-sap-support-and-sap-services-english-v1-2024.pdf)
- Fuzzy Nova is not on the Data Privacy Framework list. We do not recommend certifying
  for this one workflow. [Data Privacy Framework participant list](https://www.dataprivacyframework.gov/list)
- The 2021 SCCs cannot be used where the importer's processing is already subject to the
  GDPR under Article 3(2), which may be the case for Fuzzy Nova.
  [European Commission SCC Q&A, question 24](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/new-standard-contractual-clauses-questions-and-answers-overview_en)
- Article 49 derogations are unsuitable for a standing process that makes records
  available to maintainers. [EDPB Article 49 guidance](https://www.edpb.europa.eu/documents/guideline/guidelines-22018-on-derogations-of-article-49-under-regulation-2016679_en)

**Recommendation.** Take new acceptances by email to `licensing@ctrlyoke.dev`, and unlink
the repository from CLA Assistant now, before any outside contributor signs. A contributor
who emails Fuzzy Nova gives their data to it directly, which is not a transfer.
[EDPB Guidelines 05/2021, Example 1](https://www.edpb.europa.eu/system/files/documents/2023-02/edpb_guidelines_05-2021_interplay_between_the_application_of_art3-chapter_v_of_the_gdpr_v2_en_0.pdf)

This changes the signing method that the v2.4 memo recommended. It keeps the attribution
evidence that memo relied on: a GitHub-authenticated act (the contributor's PR comment)
tied to a retained message that names the exact CLA version. Federal E-SIGN and Texas
Business & Commerce Code §§ 322.007, .009 and .012 cover email acceptance as they did
hosted signing. [Texas Business & Commerce Code ch. 322](https://tcss.legis.texas.gov/resources/bc/htm/bc.322.htm) ·
[Archived CLA v1.0](https://ctrlyoke.dev/cla/1.0/)

The procedure:

- On an outside PR, the maintainer posts the comment in item 6, which links the archived
  CLA v1.0 and the contributor privacy notice before any personal data is requested.
- The contributor emails “I accept the ctrlyoke Contributor License Agreement v1.0 for
  [PR URL]. My GitHub username is [username].” The comment's email link fills in that text,
  so the contributor only adds their username and sends it. The PR link covers that
  submission even if it predates acceptance. CLA v1.0 covers later contributions
  automatically, so each contributor accepts once. An entity signer adds the authority
  statement in item 5. No handwritten or scanned signature is needed: the email itself is
  the electronic signature.
- The contributor then comments on the PR that they have emailed their acceptance, without
  their email address or organization name. Fuzzy Nova matches the email to the PR author
  and the confirming comment, and keeps the original message, its receipt time and the CLA
  version.
- A Google Apps Script in Fuzzy Nova's Workspace account does the matching. It records each
  acceptance in a private Google Sheet and posts a `cla` commit status to the PR. The status
  and the PR comment carry only the GitHub username, which the PR already shows. Email
  addresses and entity names stay in Workspace. An entity acceptance is left for the
  maintainer to check by hand. The `main` ruleset requires the `cla` status in place of
  `license/cla`, and code owner review stays required.

**No SAP text in the policy.** CLA Assistant holds only Fuzzy Nova's own test signature, so
the policy omits SAP. No outside signer's data reached Fuzzy Nova, so no transfer
safeguards are owed. If an outside signature does arrive before unlinking, keep its record,
ask the signer to confirm by email, and add the paragraph below to Section 3.6. Add matching
SAP entries to Sections 6, 8 and 10, with SAP's request address `cla_assistant@sap.com`. In
that case, also send SAP the question at the end of this item before relying on the record.

> For an acceptance made through CLA Assistant before [date], SAP SE operated the hosted service as an independent controller under its [Privacy Statement for CLA Assistant](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30#file-privacy-md). We keep the record we received: your GitHub username, the repository, the agreement title and version, and the signing time.

> Fuzzy Nova LLC, based in Texas, used the SAP-hosted CLA Assistant for the `FuzzyNova/ctrlyoke` GitHub repository. Which transfer mechanism covers SAP SE making signer records available to us in the United States through the repository dashboard and CSV or JSON exports? If contractual safeguards apply, please send the terms and relevant annexes or a redacted copy and explain how they bind repository owners.

(Send that question to `privacy@sap.com` and copy `cla_assistant@sap.com`.)

**Google Workspace.** Under Example 2 of the same guidelines, Fuzzy Nova's use of Google
Workspace to host those emails is an onward disclosure to a processor and a transfer. It
is the same processing Fuzzy Nova already uses for all support email. Rely on Google's
Cloud Data Processing Addendum and the existing general safeguards sentence in Section 9,
as v1.7 does, and add no CLA-specific transfer wording. Fuzzy Nova will confirm in **Admin
console → Account → Account settings → Legal and compliance → Security and Privacy
Additional Terms** that the addendum is accepted.
[Google Workspace CDPA guidance](https://knowledge.workspace.google.com/admin/compliance/privacy-compliance-and-records-for-google-workspace-and-cloud-identity) ·
[Google Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum/)

### 3. Legal basis and contributor notice

Use the contract basis for processing objectively necessary to enter into or perform a
CLA with an individual signer who is a party to it. Use legitimate interests to review
contributions, verify an entity signer's authority where the entity is the contracting
party, and keep evidence of the rights granted. Section 5 states those interests, as the
EDPB requires. Fuzzy Nova will record a legitimate interests assessment before adoption.
It explains that linking the exact agreement version, the contributor and the contribution
is necessary to establish the grant, and that a public PR alone lacks that affirmative
record. Contributors can reasonably expect a license check that is disclosed before they
sign. Limit the records to the evidence in item 4, keep email addresses and entity
confirmations private, and restrict access to people administering the CLA.
[EDPB guidance on contract necessity](https://www.edpb.europa.eu/documents/guideline/guidelines-22019-on-the-processing-of-personal-data-under-article-61b-gdpr-in_en) ·
[EDPB Guidelines 1/2024 on legitimate interests, v2.0](https://www.edpb.europa.eu/system/files/2026-11/edpb_guidelines_202401_legitimateinterest_v2_en.pdf) ·
[ICO guidance on legitimate interests](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/legitimate-interests)

Give the notice at collection. Link Section 3.6 from `CONTRIBUTING.md`, the PR template and
the item 6 comment with this text:

> Before submitting a pull request or accepting the CLA, read our [contributor privacy notice](https://ctrlyoke.dev/privacy/#36-contributions-and-contributor-license-agreement-records).

No outside contributor has accepted the CLA, so no past signer needs direct notice.
[EU GDPR, Article 13](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/) ·
[ICO guidance on when to provide privacy information](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-be-informed/)

### 4. Retention and erasure

Approve the criteria in Sections 8 and 10. Keep the minimum proof needed while a covered
contribution remains in use or distribution: the acceptance email, its receipt time, the
signer's GitHub username, the CLA version, the PR link, and the entity confirmation where
applicable. Review the records annually and when use or distribution ends. At that point,
document any legal obligation or specific need to keep evidence for claims, set a review
date, and delete records when the need ends. Apply the same test to acceptances for PRs
closed without merging. After unlinking, delete Fuzzy Nova's copies of the test signature
exports. The CLA's perpetual grant explains why the evidence can matter for as long as the
contribution remains in use.
[EU GDPR, Articles 5(1)(c) and (e), 17(3)(e), and 21](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/) ·
[ICO guidance on erasure](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)

On an erasure request, assess the need to keep each record and delete what can be deleted.
Where keeping a record is necessary for legal claims, record the reason and explain the
decision and available remedies to the requester.
[EU GDPR, Articles 12(4) and 17](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/)

### 5. Entity signatures

An entity signer includes the entity's legal name and this statement in the acceptance
email: “I confirm that I am authorized to sign the ctrlyoke Contributor License Agreement
on behalf of [entity legal name].” If authority is unclear, get confirmation from the
entity before merging.
[Prior counsel memo on acceptance records](../implemented/LICENSE_2.4_LAWYER_REVIEW.md#cla-acceptance-record)

### 6. Maintainer comment on outside pull requests

Unlinking CLA Assistant removes its fixed “Like many open source projects” comment, which
had raised a concern under License §4(e). Replace it with a maintainer comment that
describes ctrlyoke accurately and links the agreement and notice. Its “email your
acceptance” link is a `mailto:` link with the subject and acceptance text for that PR filled
in:

> Thanks for the contribution. Before we can merge this pull request, please email your acceptance of the [ctrlyoke Contributor License Agreement v1.0](https://ctrlyoke.dev/cla/1.0/) to `licensing@ctrlyoke.dev`, then reply here to say you have sent it. Please don't post your email address or organization name here. ctrlyoke is source-available, not open source. Our [contributor privacy notice](https://ctrlyoke.dev/privacy/#36-contributions-and-contributor-license-agreement-records) explains how we handle your acceptance.

[ctrlyoke License §4(e)](../../LICENSE.md#e-misrepresent-license-status)

## Companion changes

- `CONTRIBUTING.md` and the PR template describe hosted signing and the required
  `license/cla` check. Update both for the email procedure, the item 6 wording, the item 5
  entity statement and the privacy notice link.
- `landing/src/legal/license-summary.md` says the CLA Assistant bot links to the CLA.
  `legal/README.md` says CLA Assistant records the signed version, and gives the Gist steps
  for a new CLA version. Update both for the email procedure, and record how to keep
  acceptance evidence when the CLA version changes.

## Adoption checklist (Fuzzy Nova)

- Confirm CLA Assistant still holds only the test signature, then unlink the repository
  and remove `license/cla` from the `main` ruleset. If an outside signature appeared, follow
  the fallback in item 2.
- Delete local copies of the test signature exports.
- Confirm the Google Workspace Cloud Data Processing Addendum is accepted (item 2).
- Record the legitimate interests assessment and retention procedure (items 3 and 4).
- Copy the approved text into `PRIVACY.md`, set **Last Updated**, and remove the draft banner.
- Apply the companion changes. Verify the privacy anchor and test the procedure with a
  first-time contributor account.
- `npm run legal:archive`, `npm run check:legal`, landing build.
- `CHANGELOG.md` **Changed** entry; move this memo and the draft to `dev/implemented/`.
- Pro and Enterprise checkouts will record `privacy@1.8`; confirm in test mode.
