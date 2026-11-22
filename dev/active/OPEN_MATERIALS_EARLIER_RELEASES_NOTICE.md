# Draft: MIT-0 permission for Open Materials in earlier releases

**Status:** draft. Publish only after Nathan confirms the provenance check below. Counsel
approved the approach (memo Q2a, `dev/implemented/LICENSE_2.3_LAWYER_REVIEW.md`); this is
the dated notice it asks for.

## Provenance check (complete before publishing)

- [x] Git authorship of `src/templates/`, `schemas/` and `docs/` across all branches and
      tags: one author, Nathan Hickey, under two display names (`Nathan` and
      `Nathan Hickey`), one email. The only co-author trailers name GitHub Copilot, an AI
      tool, not a rights holder.
- [x] **No third-party material.** Confirmed by Nathan, November 21, 2026. Nathan confirms that no template, agent definition,
      skill, condition script, schema or documentation example was pasted in or adapted
      from an outside source, such as another project's template, a harness's own docs, or a
      blog or forum snippet, whether he or an agent did the pasting. Otherwise he lists the
      ones that were, so they can be left out of the notice. Files AI agents wrote for
      ctrlyoke at Nathan's direction are not third-party material: the AI vendors' terms give
      the output to the user, and any part that is not protected by copyright needs no
      license (the notice grants only rights Fuzzy Nova LLC has).
- [x] **Fuzzy Nova LLC holds Nathan's rights.** Confirmed November 21, 2026: the signed
      IP Assignment Agreement (effective September 14, 2026, signed September 17, 2026;
      business Drive, `Formation & Legal/`) assigns ctrlyoke to Fuzzy Nova LLC, naming its
      schemas, built-in templates and documentation in Schedule A. It also covers later work
      on ctrlyoke (§1.4) and ratifies grants made before the LLC existed (§1.5).
- [ ] **Hold for counsel's go-ahead.** Before publishing this notice, or pushing license
      v2.3, whose §5(e) makes the same grant, Nathan confirms with Fuzzy Nova's counsel on
      an open IP matter (business Drive, `Formation & Legal/`) that an irrevocable public
      MIT-0 grant raises no concern.

## Publishing

Once every box is checked, move the notice below to `legal/OPEN_MATERIALS_EARLIER_RELEASES.md`
(`git mv`), set its date to the publication date, add it to the release notes of the next
release, and link it from `legal/README.md`. It is not a versioned document, so it is not
added to `legal/versions.json`. Publish corrections as a new dated notice rather than
editing it.

---

# MIT-0 permission for Open Materials in earlier ctrlyoke releases

**Licensor:** Fuzzy Nova LLC
**Date:** [publication date]

Fuzzy Nova LLC grants recipients of the Open Materials in the ctrlyoke releases listed
below the same permission that Section 5(e) of the ctrlyoke Commercial License version 2.3
gives for Open Materials: a license under the MIT No Attribution License (MIT-0) and the
patent license described in that Section. This permission is independent of the commercial
license that governs the rest of each release. It does not require accepting version 2.3 and
does not change the terms that govern the rest of an earlier release. It applies from the
date above, and only to the extent Fuzzy Nova LLC has the right to grant it.

**Releases:** v0.1.1 and v0.1.2 (distributed with license version 2.1), and v0.2.0, v0.2.1,
v0.3.0, v0.4.0, v0.5.0, v0.5.1, v0.6.0, v0.7.0, v0.7.1 and v0.8.0 (distributed with license
version 2.2).

**Open Materials covered**, in each release:

1. the workflow templates, agent definitions, skills, and example condition scripts under
   `src/templates/`, and the copies of them that ctrlyoke creates in a project or in a
   third-party tool's configuration;
2. the code and configuration examples in the ctrlyoke documentation under `docs/`; and
3. the workflow and settings schema files under `schemas/`, including archived versions.

Material identified as subject to separate third-party terms remains subject to those terms.

The MIT-0 text is in `LICENSE-MIT-0`, distributed with ctrlyoke from the first release after
this notice and available at <https://opensource.org/license/mit-0>.
