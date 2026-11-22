---
# The LICENSE.md version this summary was checked against. terms.astro fails
# the build when LICENSE.md moves to another version, so a license change
# can't ship without this summary being reviewed against it.
licenseVersion: "2.4"
---

## Plain-language summary

This summary is here to help you read the license. It is not the license and does not change it: the full [ctrlyoke Commercial License](#ctrlyoke-commercial-license) below is the agreement, and if anything here differs from it, the license wins.

### Who can use ctrlyoke for free

- **Individuals** acting in their own personal capacity.
- **Organizations with under USD $10 million in annual revenue and fewer than 250 people**, counting full-time, part-time, and contract workers.
- **Students and academic researchers**, whatever the size of their school. This does not cover the institution's own commercial use.

When you use ctrlyoke for work, the size limit applies to every organization involved: the one that employs or engages you, any organization you use it for (such as a client), and companies under common control with them.

You can volunteer for a public project under an OSI-approved license without counting the company behind it just because it benefits. The usual organization rules still apply if the company or someone acting for it pays or hires you for that work.

The free tier includes running workflows, custom hooks, the MCP and agent managers, the CLI and MCP server, and the dashboard on the computer ctrlyoke runs on, including when you reach that computer over remote desktop or SSH. A browser on the same physical computer as a local WSL installation, container, or virtual machine running ctrlyoke counts as that computer. Scripted and CI/CD use is allowed too, as long as whoever it runs for is eligible.

### When you need a Pro license

- **Larger organizations.** If your organization has USD $10 million or more in annual revenue, or 250 or more people, every person affiliated with it who uses ctrlyoke needs a Pro license, even for the free features. That can be a personal Pro license or an Enterprise license bought by the organization. This is an honor-system check: you assess your own organization.
- **Pro features.** Anyone who wants the Pro features needs a Pro license: opening the dashboard from another device (by any route, including tunnels, proxies, and port forwarding), HTTPS certificates for remote connections, push notifications, air-gapped activation, and custom icon colors.
- **Free trial.** Each new installation gets one 14-day trial of remote dashboard access, starting the first time you use it. No payment or account is needed.

### Pro and Enterprise licenses

- **Individual Pro** is a one-time purchase that does not expire. A future major version may need a new license, but the version you bought keeps working under your license.
- A Pro license is **personal** to the person who holds it. You can't resell or transfer it without our written permission.
- **Enterprise** is an annual subscription for one legal entity. It covers that entity's employees and officers, and contractors while they work for it. The [Enterprise Subscription Terms](/enterprise-terms) and, where it applies, the [Data Processing Agreement](/dpa) also govern it.
- We can suspend or revoke a Pro license for a serious breach of the license, a fraudulent purchase or chargeback, or a legal violation such as breaking export controls. Where reasonable, we'll warn you first and give you a chance to fix it. Your free-tier rights continue.

### What you can't do

- **Redistribute ctrlyoke** in source or compiled form. You can't publish releases, packages, or binaries from a fork.
- **Reuse its code in a competitor**, or build ctrlyoke into one. A competitor is a product or service whose main or substantial feature is orchestrating multi-step AI coding-assistant workflows through structured files. You can still use ctrlyoke as an internal development tool, including while building a competing product, and you're free to implement the same ideas and documented formats independently.
- **Get around the license checks**, use Pro features without a license or an active trial, or restart or stack trials.
- If you accidentally break the license-check, Pro use, or trial rules in a way that could end your license, you have 30 days from our written notice to stop the use or get a Pro license that covers it. You can fix the breach without paying for past use.
- **Offer ctrlyoke as a hosted service** to other people. Running it on your own machines and network for your own work is fine, including remote dashboard access for your own use (a Pro feature).
- **Call it open source.** ctrlyoke is source-available under a commercial license.
- **Remove** copyright notices, proprietary notices, or logos from the commercial software.

### Templates, examples, and schemas are MIT-0

The built-in workflow templates, agent definitions, skills, and example condition scripts, the code and configuration examples in the documentation, and the workflow and settings schemas are licensed separately under the permissive [MIT No Attribution License (MIT-0)](https://opensource.org/license/mit-0), with an express patent grant from Fuzzy Nova. You can copy, change, and share them, including the copies ctrlyoke puts in your projects, without keeping any notice. That permission also covers those materials in earlier ctrlyoke releases. Templates from the separate community library are third-party material under that library's own license: review a template before you run it, because it can run commands and tell AI tools to change files.

### Source code, forks, and contributions

- The source code is public so you can read it. That doesn't give you any rights beyond the license.
- You can fork it with GitHub's fork button to evaluate it, review its security, adapt it for internal use, or prepare a contribution. A fork stays under this license.
- If you send a pull request or other contribution, you give Fuzzy Nova a permanent license to use it in ctrlyoke and future products, and you confirm it's yours to give. A contribution to the MIT-0 materials can be shared under MIT-0. We may ask you to sign a separate Contributor License Agreement first.
- The license never turns into an open-source license at a later date.

### AI tools are yours to bring

ctrlyoke drives AI coding assistants such as GitHub Copilot CLI, Claude Code, and Codex, but it doesn't include them. You supply those tools and their subscriptions or credits, and their own terms apply to how you use them.

Workflows and the AI tools they direct can read, change, and delete files, run programs, rewrite git history, and reach the network, within the permissions your environment gives them. Review workflows and templates before you run them, set those permissions deliberately, check what they did, and keep backups of important work, including files outside version control.

### Your content and your data

The workflows, prompts, settings, run history, and output you create with ctrlyoke stay yours, to the extent they are anyone's. We don't claim them, and the license gives us no general right to access them. What ctrlyoke collects, such as telemetry and license-validation data, is covered by the [Privacy Policy](/privacy).

### No warranty, limited liability

ctrlyoke is provided as is, without any warranty. As far as the law allows, we aren't liable for indirect losses such as lost data or profits, and our total liability is capped at the greater of what you paid us in the previous 12 months or USD $100. The limits don't cover fraud, willful misconduct, gross negligence, death or personal injury caused by negligence, or product liability that the law doesn't let us limit. Consumer rights that your local law doesn't let a contract take away, such as consumer guarantees in Australia, New Zealand, the UK, and the EU, still apply.

### If you use ctrlyoke for business

If you're not using ctrlyoke as a consumer, you agree to defend Fuzzy Nova against third-party claims to the extent they come from your own content and AI output, your breach of the license's restrictions, your violation of the law or of an AI service's terms, or a product or service you provide to others using ctrlyoke. This doesn't cover claims that ctrlyoke itself infringes someone's rights, or claims caused by our own breach or fault.

### Ending the license

The license lasts until it ends. It ends if you seriously break it and don't fix the problem within 30 days of our notice. Redistributing ctrlyoke, getting around the license checks, or knowingly and materially breaking the competitor rules ends it immediately. When the license ends, you must stop using ctrlyoke and delete your copies. You can keep the MIT-0 materials and your own content.

### Disputes

Texas law governs the license. The ordinary forum is Texas. The license designates state district courts and county courts at law in Travis County and the federal district court's Austin Division, subject to applicable venue rules. Eligible small claims can be brought in a small-claims court with jurisdiction. Consumers keep their mandatory protections and forum rights. Consumers who usually live outside the United States can also use the courts where they usually live for disputes about personal or household use. After a dispute arises, both sides can agree in writing to mediation or arbitration.

### Questions

Email `licensing@ctrlyoke.dev`.
