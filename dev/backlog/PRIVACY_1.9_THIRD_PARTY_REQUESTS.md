# Privacy Policy v1.9 proposal: requests the Software makes to third-party services

**Status:** Proposal, not yet sent to counsel. Written November 22, 2026.

When this goes to counsel, follow "Releasing a new version" in `legal/README.md`. Move this
memo to `dev/active/PRIVACY_1.9_LAWYER_REVIEW.md`, write the complete draft beside it as
`dev/active/PRIVACY_1.9_DRAFT.md` (`PRIVACY.md` v1.8 plus the change below), and leave the root
`PRIVACY.md` alone until counsel approves.

## Approval requested (for counsel)

> Do you approve adding the paragraph in "Proposed change" to Section 1 (Scope) of the Privacy
> Policy, and the practices in "Recommendations"? If a requirement applies that this memo has
> missed, or you would word the paragraph differently, please say which part.

## The question

Several optional features of ctrlyoke send HTTP requests **directly from the user's machine to
third-party services**. Fuzzy Nova never receives, proxies, logs or stores these requests. The
Privacy Policy (v1.8) does not mention them. It lists only the vendors Fuzzy Nova itself uses,
and Section 2 says the Software does not collect or transmit listed data "to us". The requests
are listed in the public docs instead ([Privacy and telemetry → Other network
requests](https://ctrlyoke.dev/docs/guide/privacy#other-network-requests)).

Does the Privacy Policy need to describe them?

## The requests

Every request happens only after a deliberate user action. None runs when a settings tab or
the dashboard opens (enforced since commit `55a5e282c`, which made the community templates list
click-to-load). Each carries a fixed ctrlyoke User-Agent, no identifiers and no
authentication. Each feature names its service in the UI before or at the click.

| Trigger                                                                                      | Service                                                                                   | Data received                                                                   |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| User opens the **MCP Registry** tab in the MCP manager, searches it, or pages through it     | `registry.modelcontextprotocol.io`                                                        | Search text, IP address                                                         |
| User chooses **Browse skills.sh**, or searches it                                            | `skills.sh` (Vercel)                                                                      | Search text, public `owner/repo` and name of each listed skill (for audits), IP |
| User reviews, installs or checks for updates to a skill from skills.sh                       | `api.github.com`, `raw.githubusercontent.com`                                             | Public repository paths, IP address                                             |
| User chooses **Browse community templates** or **Refresh**, or installs a community template | `cdn.jsdelivr.net`, serving Fuzzy Nova's public `FuzzyNova/ctrlyoke-templates` repository | Index and template file names, IP address                                       |
| User turns on push notifications for the self-hosted dashboard (Pro)                         | The user's browser vendor's push service, chosen by the user's browser                    | Encrypted notification, IP address of the machine running ctrlyoke              |

Fuzzy Nova's own vendors (Azure telemetry, Keygen licensing and the rest of Section 6) are
already covered and are out of scope here.

## Findings

This is a research summary prepared with an AI research assistant, not legal advice. Several
primary sources could not be retrieved; those points are marked _unverified_ and are the ones
counsel should check.

### EU and UK GDPR: probably not a controller, with one weak point

- **Fashion ID (CJEU C-40/17, 2019).** A website that embedded Facebook's Like button was a
  joint controller for the collection and transmission of visitors' data, although it never
  had access to that data, and it owed them the Article 13 information for that stage. That
  is the strongest argument that a vendor can be a controller for a transmission it designed.
- **Why ctrlyoke differs.** The embedded button sent data automatically on every page load,
  for the site operator's commercial benefit. Here, each request follows a click, goes to a
  service the user chose to search or install from, and gives Fuzzy Nova nothing. The better
  view is that the user determines the purpose and means of each request, and Fuzzy Nova ships
  the client, as a browser maker does. No case was found holding a software vendor a
  controller in this situation, so this is an inference, not settled law.
- **Weak point: jsDelivr.** Fuzzy Nova chose that host and it serves Fuzzy Nova's own content;
  the user chooses to browse the library, not to contact jsDelivr. The German Google Fonts
  rulings (LG München I, 3 O 17493/20, 20 January 2022) penalised an automatic IP transfer to a
  CDN when self-hosting was possible. A click-triggered request is different, but the
  self-hosting argument still applies, since the files could be fetched from GitHub instead.
  No regulator decision on jsDelivr was found; jsDelivr's own guidance (vendor-written)
  recommends a privacy-policy notice.
- **IP addresses** should be treated as personal data (Breyer, C-582/14, _unverified_; EDPS v
  SRB, C-413/23 P, 2025, assesses identifiability from the recipient's side, and GitHub, Vercel
  and jsDelivr can identify users).
- **If Fuzzy Nova is a controller,** Article 13(1)(e) requires the recipients or categories of
  recipients, given at the time of collection. A layered notice (in-app hint plus docs page plus
  policy) can meet that (EDPB transparency guidance, _unverified_).
- **International transfers (Article 44 onward)** arise only if Fuzzy Nova is the exporter.
  When the user's machine sends the request, Fuzzy Nova makes no transfer. Section 9 needs no
  change.
- EDPB Guidelines 07/2020 on controllers and processors, and WP29 Opinion 02/2013 on apps,
  could not be retrieved; their reading here is _unverified_.

### United States: not required

- **CCPA/CPRA.** Obligations attach to personal information a business collects. Data Fuzzy
  Nova never receives is not collected, sold or shared by it. Separately, Fuzzy Nova is likely
  below every threshold (gross revenue over $26.625M as adjusted for 2025, or 100,000 or more
  consumers, or half of revenue from selling or sharing; the consumer-count figure is
  _unverified_).
- **CalOPPA** (Bus. & Prof. Code § 22575) requires the categories of third parties with whom the
  operator "may share" personal information it collects. It is not triggered by data the
  operator never collects.
- **FTC Act § 5.** The risk is a statement that misleads. The policy's "to us" wording is
  literally true. The risk is a reader concluding that nothing leaves their machine. The
  public docs had a heading, "What never leaves your machine", that read that way. It was
  renamed "What ctrlyoke never sends to us" in the commit that added this memo.

### Distribution and practice

- No Visual Studio Marketplace or npm rule requiring a list of the network calls was found. The
  Marketplace Publisher Agreement itself was not read (_unverified_).
- Comparable tools checked (Homebrew, Obsidian) list the hosts their apps contact in help
  documentation, not in their legal policies. VS Code, JetBrains, npm CLI, GitHub Desktop and Zed
  were not checked. The likely norm is a general policy clause plus a docs list.

### Conclusion

| Regime            | Verdict                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| EU/UK GDPR        | Recommended. Required only if Fuzzy Nova is a joint controller; jsDelivr is the likeliest case. |
| CCPA/CPRA         | Not required.                                                                                   |
| CalOPPA           | Not required.                                                                                   |
| FTC Act § 5       | Recommended, so no reader takes the policy to promise that nothing leaves the machine.          |
| Marketplace / npm | Nothing found that requires it.                                                                 |

The open question is whether a regulator would treat a vendor as a joint controller for
requests its software makes at the user's request. No authority settles it. A short clause
costs little and closes it.

## Proposed change

Add this paragraph to **Section 1 (Scope)**, after the paragraph about third-party AI coding
assistants:

> Some optional features of the Software connect directly from your device to third-party
> services when you use them: searching the MCP Registry or skills.sh, installing or updating
> skills from GitHub, browsing and installing community templates, which are delivered by the
> jsDelivr content delivery network, and browser push notifications. Each connection is made
> only when you use the feature. We do not receive, route or store these requests. The service
> you connect to receives your IP address and the content of the request, such as your search
> text, and handles it under its own privacy policy. A current list of these services and what
> each receives is at [ctrlyoke.dev/docs/guide/privacy#other-network-requests](https://ctrlyoke.dev/docs/guide/privacy#other-network-requests).

Drafting notes:

- **Kinds of service, not a host list.** Naming features rather than every host means a moved
  endpoint is a docs change, not a new policy version. jsDelivr is named because it is the one
  host the user does not choose (see "Weak point").
- **Section 2 stays as written.** Its "to us" scoping is accurate. Do not add any statement
  that the Software sends nothing anywhere.
- **Section 6 stays as written.** These services are not Fuzzy Nova's vendors, and listing
  them there would suggest a processor relationship that does not exist.
- **Version 1.9**, with "Last Updated" set to the adoption date, per `legal/README.md`.

## Recommendations

1. Adopt the Section 1 paragraph above as Privacy Policy v1.9.
2. Keep a notice in the UI at the point of each click naming the service (already true for the
   MCP Registry tab, the skills.sh panel and **Browse community templates**).
3. Keep every such request click-triggered, never on load. A new feature that contacts a third
   party gets a row in the docs table in the same commit.
4. Optional, to remove the jsDelivr question entirely: fetch the community index and templates
   from `raw.githubusercontent.com` instead. That trades jsDelivr's CDN caching for GitHub's
   rate limits, and does not change the policy wording beyond the CDN mention.

## Sources

- Fashion ID: [CJEU press release](https://curia.europa.eu/jcms/upload/docs/application/pdf/2018-12/cp180206en.pdf), [Inside Privacy summary](https://www.insideprivacy.com/international/european-union/cjeu-rules-that-facebook-and-website-operators-are-joint-controllers-if-the-website-embeds-facebooks-like-button/)
- [EDPB Guidelines 07/2020](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-072020-concepts-controller-and-processor-gdpr_nb)
- [LG München I, 3 O 17493/20](https://www.gesetze-bayern.de/Content/Document/Y-300-Z-GRURRS-B-2022-N-612)
- [EDPS v SRB, C-413/23 P](https://eur-lex.europa.eu/case/EN/C_413_23_P); [Clifford Chance commentary](https://www.cliffordchance.com/insights/resources/blogs/talking-tech/en/articles/2025/09/pseudonymized-data-after-edps-v-srb.html)
- jsDelivr: [Google Fonts ruling post](https://www.jsdelivr.com/blog/how-the-german-courts-ruling-on-google-fonts-affects-jsdelivr-and-why-it-is-safe-to-use/) (vendor), [privacy policy](https://jsdelivr.com/privacy-policy-jsdelivr-net)
- [CalOPPA § 22575](https://law.justia.com/codes/california/code-bpc/division-8/chapter-22/section-22575/); [CPPA threshold adjustment](https://www.cppa.ca.gov/regulations/cpi_adjustment.html)
- [Homebrew analytics](https://docs.brew.sh/Analytics); [Obsidian security](https://obsidian.md/help/teams/security)
