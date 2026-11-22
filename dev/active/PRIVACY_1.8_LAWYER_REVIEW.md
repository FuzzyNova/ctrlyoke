# ctrlyoke Privacy Policy v1.8 review memo

**Prepared for outside counsel on behalf of Fuzzy Nova LLC · November 22, 2026**

[Open the complete v1.8 draft](PRIVACY_1.8_DRAFT.md) ·
[License v2.4 memo, CLA acceptance record](../implemented/LICENSE_2.4_LAWYER_REVIEW.md#cla-acceptance-record) ·
[Current policy (v1.7)](https://ctrlyoke.dev/privacy/)

## Approval requested

> Do you approve the recommendations below, including the direct-email signing procedure in item 2 if the existing records do not establish coverage for hosted signing? A single “approved” is enough. If any item needs a change, please identify its number and the wording or practice you would prefer.

## Background

Following the v2.4 memo, Fuzzy Nova set up the hosted CLA Assistant on November 22, 2026.
It presents the exact CLA v1.0 text from a dedicated GitHub Gist. A contributor signs in
with GitHub and signs. The `main` branch then requires CLA Assistant's `license/cla`
status before an outside PR can merge. The maintainer's account and `dependabot[bot]` are
exempt. Signing was tested end to end on a fork PR. CLA v1.0 itself is unchanged.

Privacy Policy v1.7 mentions GitHub in its support section. The draft adds how Fuzzy Nova
handles contributions and CLA records.

- SAP SE identifies itself as the controller of cla-assistant.io. Its notice says it uses
  GitHub identity and associated email to operate the service, authenticate signers, and
  make acceptance records available to project owners. SAP also covers data entered in
  optional fields. Fuzzy Nova has configured none. [SAP Privacy Statement for CLA Assistant](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30#file-privacy-md)
- The service documents Azure storage in Europe. SAP describes retention criteria based
  on providing the service, making acceptance records available, and its legal needs.
  [CLA Assistant storage documentation](https://github.com/cla-assistant/cla-assistant#where-is-the-list-of-signees-stored) ·
  [SAP Privacy Statement for CLA Assistant](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30#file-privacy-md)
- On November 22, 2026, we verified the live `FuzzyNova/ctrlyoke` signature report and both
  exports using its existing test signature. The report shows the GitHub username, signing
  date, and a revocation date column. Both CSV and JSON include the username, repository
  owner and name, CLA title, Gist URL and revision, signing and revocation timestamps, and
  whether the agreement was linked at the GitHub organization level. Both exports omit the
  email address. Their username, signing timestamp, and Gist revision matched. The pinned
  Gist revision contained the exact text of [archived CLA v1.0](../../legal/archive/cla/1.0.md).
  [CLA Assistant export documentation](https://github.com/cla-assistant/cla-assistant#where-can-i-see-the-list-of-signees-is-there-a-way-to-importexport-the-signee-data) ·
  [Published export code](https://github.com/cla-assistant/cla-assistant/blob/main/src/client/src/controller/settings.js)

## Changes in v1.8

| Section | Change                                                                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Scope adds contributing to the ctrlyoke repository.                                                                                                        |
| 3.6     | Describes GitHub contributions, public CLA checks, SAP's processing, Fuzzy Nova's signature records, entity confirmations, and earlier acceptance records. |
| 4       | Adds reviewing contributions and keeping CLA records as a use.                                                                                             |
| 5       | Identifies the basis for administering an individual CLA, reviewing contributions, verifying entity authority, and keeping evidence of rights.             |
| 6       | Adds SAP SE (CLA Assistant) to the recipients table, marked as an independent controller.                                                                  |
| 8       | Sets retention criteria and periodic review for CLA records.                                                                                               |
| 9       | Discloses U.S. access to CLA records and how to ask about applicable safeguards.                                                                           |
| 10      | Explains when Fuzzy Nova may retain CLA evidence after an erasure request and how to contact SAP.                                                          |

## Recommended answers

### 1. Approval of v1.8

Approve the privacy disclosures for the signing workflow Fuzzy Nova actually uses. The
attached draft describes the hosted configuration. Approve it for publication with hosted
signing only if the transfer evidence in item 2 is on file and Section 9 reflects it.
On the evidence available today, use direct email for new signatures and apply the wording
and companion edits in item 2 before publishing the policy. Keep CLA v1.0 for either signing
method.

### 2. SAP SE's role and international access

Treat SAP as an independent controller for operating the hosted service and Fuzzy Nova as
controller for reviewing contributions and using the signature records. SAP's published
notice and control over hosting, authentication, service terms, and its own retention
support this reading. Fuzzy Nova selects the tool and sets the repository's signing
requirement. The available evidence supports separate decisions about those purposes and
means. Revisit the classification if the actual terms or practices show shared control of
a specific processing step or processing solely on Fuzzy Nova's instructions, which would
call for an Article 26 arrangement or Article 28 terms respectively.
[SAP Privacy Statement for CLA Assistant](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30#file-privacy-md) ·
[EDPB guidance on controllers and processors](https://www.edpb.europa.eu/documents/guideline/guidelines-072020-on-the-concepts-of-controller-and-processor-in-the-gdpr_en)

Treat the disclosure as a Chapter V transfer on the facts available. SAP SE in Germany
is the exporter and Fuzzy Nova in Texas is the importer. Viewing the report makes records
available to a separate controller in a third country even without a download. The GitHub
username links the signature to a person, and the signing timestamp and agreement revision
show their acceptance. European storage and exports that omit email reduce the scope of
the data involved in that disclosure. The report still contains personal data.
[EDPB guidance on international transfers, paragraphs 9 and 16](https://www.edpb.europa.eu/system/files/documents/2023-02/edpb_guidelines_05-2021_interplay_between_the_application_of_art3-chapter_v_of_the_gdpr_v2_en_0.pdf) ·
[EU GDPR, Articles 13–14 and 44–46](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/)

**Finding. No verified Chapter V mechanism covers the SAP-to-Fuzzy Nova disclosure in
the evidence reviewed.** This is the result of the November 22, 2026 public-source review.
An applicable agreement in Fuzzy Nova's own records or SAP's records could change the result.

- **SAP's public materials establish the purpose and the parties' access.** The terms
  incorporate SAP's privacy statement. That statement explains that SAP makes signed
  records available to project owners and generally uses EU Standard Contractual Clauses
  (SCCs) for transfers without adequacy coverage. The published terms and GitHub App
  listing provide no operative SCCs or annex that binds Fuzzy Nova and covers the dashboard
  or exports. SAP's customer Trust Center offers product-specific factsheets behind sign-in.
  Its general cloud DPA covers services included in a customer agreement. Check for a
  separately accepted CLA Assistant addendum or account-specific agreement if already on file.
  [SAP terms and privacy statement, reviewed revision](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30/9a01b923d6b60a0cce8a0568c6dc4fe3caafb5eb) ·
  [CLA Assistant GitHub App](https://github.com/apps/cla-assistant) ·
  [SAP Cloud Services DPA, sections 1 and 2](https://assets.cdn.sap.com/agreements/data-processing-agreements/sps/data-processing-agreement-for-cloud-services-sap-support-and-sap-services-english-v1-2024.pdf) ·
  [SAP guide to international transfers and factsheets](https://www.sap.com/israel/documents/2025/04/acdc1f8a-027f-0010-bca6-c68f7e60039b.html)
- **Adequacy coverage is unverified.** The active U.S. Data Privacy Framework list returned
  no results for “Fuzzy Nova” and “ctrlyoke.” GitHub's certification concerns GitHub's own
  covered processing. Recommend that Fuzzy Nova skip voluntary certification for this one
  workflow. Certification could support future covered transfers if Fuzzy Nova later has
  recurring EU transfer needs. [U.S. Data Privacy Framework participant list](https://www.dataprivacyframework.gov/list) ·
  [FTC overview of voluntary certification](https://www.ftc.gov/business-guidance/privacy-security/data-privacy-framework) ·
  [GitHub Privacy Statement, international transfers](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement#international-data-transfers)
- **The signing step and its disclosures serve other purposes.** SAP's Article 6 bases,
  the CLA signature, and the privacy-policy checkbox do not supply the transfer mechanism.
  Recommend against using Article 49's occasional contractual derogations for a standing
  process that makes records available to maintainers. [EDPB Article 49 guidance](https://www.edpb.europa.eu/documents/guideline/guidelines-22018-on-derogations-of-article-49-under-regulation-2016679_en)

TestPlanIt identifies SAP as an independent controller and lists the fields it receives
through the hosted CLA Assistant. Its international-transfer section describes its hosting,
support, and other infrastructure transfers. Hydra's policy describes access to and export
of hosted CLA records. Both provide examples for Section 3.6. Neither identifies the
instrument that covers this disclosure for Fuzzy Nova. [TestPlanIt privacy policy](https://www.testplanit.com/privacy) ·
[Hydra privacy policy](https://hydra.cc/privacy/)

**What would support keeping the hosted workflow.** Record an applicable adequacy basis or
a binding instrument that covers SAP's disclosure to Fuzzy Nova through the dashboard and
exports. If relying on SCCs, keep the terms, the parties' acceptance, and the annexes showing
the roles and covered data flow. Establish that the clauses apply to this processing. The
Commission's 2021 transfer SCCs are limited to importers whose processing of the transferred
data is outside the GDPR's direct scope. Once the mechanism is verified, name it in Section 9
and give the appropriate way to request a copy of the safeguards. [European Commission SCC guidance, questions 6, 13, 24 and 39](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/new-standard-contractual-clauses-questions-and-answers-overview_en)

If Fuzzy Nova prefers to keep the hosted workflow and cannot find the required evidence
in its own records, use the following request to `privacy@sap.com`, copying
`cla_assistant@sap.com`.

> Fuzzy Nova LLC, based in Texas, uses the SAP-hosted CLA Assistant for the `FuzzyNova/ctrlyoke` GitHub repository. Which transfer mechanism covers SAP SE making signer records available to us in the United States through the repository dashboard and CSV or JSON exports? Please confirm SAP's role for this disclosure. If contractual safeguards apply, please send the terms and relevant annexes or a redacted copy and explain how the terms bind repository owners. If you rely on adequacy, please identify the coverage that applies to this disclosure.

**Recommended path without a SAP email.** Use maintainer-reviewed acceptance sent directly
to `licensing@ctrlyoke.dev` for new signatures if no qualifying agreement is on file.
Contributors write to Fuzzy Nova at its published business address, removing the SAP-to-Fuzzy
Nova disclosure for new signatures. Verify the Google Workspace Cloud Data Processing
Addendum in **Admin console → Account → Account settings → Legal and compliance → Security
and Privacy Additional Terms**, including the transfer terms for handling these messages.
Direct collection and Google's processing are separate steps. [EDPB direct-collection examples 1–2](https://www.edpb.europa.eu/system/files/documents/2023-02/edpb_guidelines_05-2021_interplay_between_the_application_of_art3-chapter_v_of_the_gdpr_v2_en_0.pdf) ·
[Google Workspace CDPA guidance](https://knowledge.workspace.google.com/admin/compliance/privacy-compliance-and-records-for-google-workspace-and-cloud-identity) ·
[Google Cloud Data Processing Addendum](https://cloud.google.com/terms/data-processing-addendum/)

- Provide the [archived CLA v1.0](https://ctrlyoke.dev/cla/1.0/) and the contributor privacy
  notice before asking for acceptance. Ask the contributor to send “I accept the ctrlyoke
  Contributor License Agreement v1.0 for [PR URL]. My GitHub username is [username].” The PR
  link expressly covers that submission if it predates acceptance. For an entity, include its
  legal name and the authority statement in item 5 in the same email. Confirm that the
  acceptance is attributable to the GitHub contributor before merging. If necessary, have
  them confirm from the submitting GitHub account using a reference that reveals no email
  address or company name. Keep the original message, its receipt timestamp and the exact
  CLA version. Existing valid acceptances carry forward. [Archived CLA v1.0](../../legal/archive/cla/1.0.md) ·
  [Texas Business & Commerce Code §§ 322.007, .009 and .012](https://tcss.legis.texas.gov/resources/bc/htm/bc.322.htm)
- Update the PR template, `CONTRIBUTING.md`, license summary, and `legal/README.md` for the email
  procedure. Before replacing the bot's required `license/cla` status, set up and test a
  maintainer review requirement for affirmative acceptance so an outside PR still needs
  verification before merging. Unlink this repository from the hosted service when the email
  procedure goes live. Retain necessary evidence already held under item 4. Avoid pulling more
  third-party signer records from SAP unless coverage is documented.
- In the privacy draft, replace the hosted signing instructions in Section 3.6 with the
  text below. In Section 6, add CLA email to the purpose for Google Workspace and describe
  the SAP row as covering earlier hosted signatures. In Section 8, say SAP retains earlier
  hosted records under its privacy statement. In Section 9, state that Fuzzy Nova processes
  CLA records in the U.S., including any previously received through the hosted service.
  Disclose the safeguards actually used for any ongoing restricted transfer, including any
  applicable Google Workspace transfer terms. Keep SAP's contact in Section 10 for records
  it controls from earlier hosted signing.

> We generally require acceptance of the [ctrlyoke Contributor License Agreement](https://ctrlyoke.dev/cla) before merging a contribution. You accept it by emailing Fuzzy Nova. We receive your email address, GitHub username, pull request link, and statement accepting the applicable agreement version. If you sign for an organization, we also receive its legal name and your confirmation that you are authorized to bind it. We use Google Workspace to host the email and keep the acceptance as evidence of the rights granted in your contribution.
>
> For earlier acceptances through [CLA Assistant](https://cla-assistant.io/), SAP SE handled signing as an independent controller under its [Privacy Statement for CLA Assistant](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30#file-privacy-md). We may keep the signature evidence we received under the retention criteria in Section 8.

### 3. Legal basis and contributor notice

If hosted signing continues, leave its optional privacy-policy field blank. It adds a
checkbox asking the signer to accept the project's handling of their information. In either
workflow, link Section 3.6 from `CONTRIBUTING.md` and the PR template before collecting a
signature. Suggested copy for both locations follows.

> Before submitting a pull request or accepting the CLA, read our [contributor privacy notice](https://ctrlyoke.dev/privacy/#36-contributions-and-contributor-license-agreement-records).

Use the contract basis for processing objectively necessary to enter into or perform a
CLA with an individual signer who is a party to it. Use legitimate interests to review
contributions, verify an entity signer's authority where the entity is the contracting
party, and preserve evidence of granted rights. Record the legitimate interests assessment
for those purposes. The assessment should explain why linking the exact agreement version,
the contributor, and the contribution is necessary to establish the grant. The public PR
by itself lacks that affirmative record. Contributors can reasonably expect a license check
when the requirement is disclosed before signing. Limit the records to the evidence in item
4, keep contact information and entity confirmations private, and restrict access to people
administering the CLA. CLA assent is the contributor's agreement to the license.
[CLA Assistant signing template](https://github.com/cla-assistant/cla-assistant/blob/main/src/client/assets/templates/cla.html) ·
[EDPB guidance on contract necessity](https://www.edpb.europa.eu/documents/guideline/guidelines-22019-on-the-processing-of-personal-data-under-article-61b-gdpr-in_en) ·
[EDPB guidance on legitimate interests](https://www.edpb.europa.eu/system/files/2026-11/edpb_guidelines_202401_legitimateinterest_v2_en.pdf) ·
[ICO guidance on legitimate interests](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/a-guide-to-lawful-basis/legitimate-interests) ·
[ICO guidance on when to provide privacy information](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-be-informed/)

At adoption, give the new notice directly to known external signers through existing
contact details where reasonably available. Use the contributor links for future signers.
Document any applicable Article 14 exception before relying on a public notice alone for
records obtained indirectly. Preserve valid acceptances when the notice or signing method
changes. [EU GDPR, Articles 13–14](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/)

### 4. Retention and erasure

Approve the criteria in Sections 8 and 10. Keep the minimum proof needed while a covered
contribution remains in use or distribution. That usually means the signer's GitHub
username, signature time, agreement text or Gist revision, the link to the contribution,
and the entity confirmation when applicable. Keep earlier PR and email acceptances as
evidence under the same criteria. Restrict access to exports and review them annually and
when use or distribution ends. At that point, document any legal obligation or specific
need to keep evidence for claims, set a review date, and delete records when the need ends.
Apply the same necessity test to signed PRs that are closed without merging. Once a test
record is no longer needed to validate the procedure, discard Fuzzy Nova's copies unless
they support an actual contribution or legal need. The CLA's perpetual grant explains why
the evidence can matter while the contribution remains in use.
[EU GDPR, Articles 5(1)(c) and (e), 17(3)(e), and 21](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/) ·
[ICO guidance on erasure](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)

On an erasure request, assess the actual need to preserve each record and delete what can
be deleted. Where an applicable exception is necessary for legal claims, record the reason
and explain the decision and available remedies to the requester. Fuzzy Nova handles the
records it controls. SAP takes requests about the hosted records at `cla_assistant@sap.com`.
[EU GDPR, Articles 12(4) and 17](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/) ·
[SAP Privacy Statement for CLA Assistant](https://gist.github.com/CLAassistant/3a73e4cd729c9d0a6e30#file-privacy-md)

### 5. Entity signatures

Use a private email to `licensing@ctrlyoke.dev` to record the signer's GitHub username,
PR link, the entity's legal name, and the statement “I confirm that I am authorized to sign
the ctrlyoke Contributor License Agreement on behalf of [entity legal name].” Include this
statement in the acceptance email under the direct-email procedure. If hosted signing continues, keep custom
fields disabled and match the email confirmation to the hosted signature and CLA version.
Seek separate confirmation from the entity if authority is unclear before merging.
[Prior counsel memo on acceptance records](../implemented/LICENSE_2.4_LAWYER_REVIEW.md#cla-acceptance-record) ·
[CLA Assistant documentation on custom fields](https://github.com/cla-assistant/cla-assistant#request-more-information-from-the-cla-signer)

### 6. “Open source” in the bot comment

Keep the hosted comment if the hosted flow continues. License §4(e) governs how licensees
represent the software. The bot uses a generic comparison to other projects. Retain the
source-available description in the PR template and add it near the signing instruction in
`CONTRIBUTING.md`. Under the direct-email flow, use “Please email your acceptance of the
ctrlyoke Contributor License Agreement before we can merge this pull request.”
[ctrlyoke License §4(e)](../../LICENSE.md#e-misrepresent-license-status) ·
[Example of the hosted bot comment](https://github.com/xdevplatform/xmcp/pull/9)

## Companion changes

- The PR template and `CONTRIBUTING.md` already describe hosted signing and the required
  `license/cla` status. At adoption, update both for the approved signing flow, add the
  privacy notice and source-available wording, and use the entity instructions in item 5.
- Align the website license summary and `legal/README.md` with that flow and document how
  to preserve acceptance evidence when the CLA version changes.

## Adoption checklist (Fuzzy Nova)

- The hosted dashboard, CSV, and JSON were checked against Sections 3.6 and 6. The signature
  timestamp and the CLA v1.0 text at the recorded Gist revision were verified.
- Record any applicable CLA Assistant transfer mechanism already on file. If none is on
  file, use the direct-email procedure in item 2 unless Fuzzy Nova chooses to request
  supporting terms from SAP. Confirm the selected procedure before publishing its notice.
- Record the assessment, notice, and retention procedure in items 3 and 4.
- Copy the approved text into `PRIVACY.md`, set **Last Updated**, and remove the draft banner.
- Apply the companion edits. If hosted signing continues, leave its privacy-policy field
  blank. Verify the privacy anchor and test the notice and merge requirement with a first-time
  contributor.
- `npm run legal:archive`, `npm run check:legal`, landing build.
- `CHANGELOG.md` **Changed** entry; move this memo and the draft to `dev/implemented/`.
- Pro and Enterprise checkouts will record `privacy@1.8`; confirm in test mode.
