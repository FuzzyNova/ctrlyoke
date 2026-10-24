import * as assert from "assert";
import { suite, test } from "mocha";
import {
  SKILL_INSTALL_LIMITS,
  SkillsRegistryError,
  SkillsShRegistryClient,
  checkSkillUpdatesBatch,
  fetchSkillAuditsBatch,
  type InstalledRegistrySkill,
  parseSkillAuditResponse,
  parseSkillsSearchResponse,
  parseTopSkillsSnapshot,
  rankSkillMdCandidates,
  sanitizeRegistryText,
  selectSkillFiles,
  toSkillRelativePath,
  toSkillSlug,
} from "../../utils/SkillsRegistryClient";
import {
  SKILL_AUDIT_STATUSES,
  SKILL_UPDATE_STATUSES,
} from "../../types/DashboardConstants";
import type { RegistrySkillLocation } from "../../types/WebviewMessageTypes";

const COMMIT = "dbd4588f9e1033efb41dad4bef2f7947c8993d44";
const BASE = "https://skills.test";

type Route = (url: string) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A fake fetch answering by URL prefix; records every URL it is asked for. */
function fakeFetch(routes: Record<string, Route>): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const match = Object.keys(routes)
      .filter((prefix) => url.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) return new Response("not found", { status: 404 });
    return routes[match]!(url);
  }) as typeof fetch;
  return { fetch: fetchFn, urls };
}

function client(routes: Record<string, Route>) {
  const fake = fakeFetch(routes);
  return {
    registry: new SkillsShRegistryClient({ fetch: fake.fetch, baseUrl: BASE }),
    urls: fake.urls,
  };
}

const PDF_TREE = {
  sha: "tree",
  truncated: false,
  tree: [
    { path: "README.md", type: "blob", size: 10 },
    { path: "skills", type: "tree" },
    { path: "skills/pdf", type: "tree" },
    { path: "skills/pdf/SKILL.md", type: "blob", size: 40 },
    { path: "skills/pdf/scripts/fill.py", type: "blob", size: 5 },
    { path: "skills/pdf/link", type: "blob", mode: "120000", size: 5 },
    { path: "skills/pdf/__pycache__/x.pyc", type: "blob", size: 5 },
    { path: "skills/docx/SKILL.md", type: "blob", size: 40 },
  ],
};

const PDF_SKILL_MD =
  "---\nname: pdf\ndescription: Work with PDFs\n---\n# PDF\n";

function githubRoutes(
  tree: unknown = PDF_TREE,
  files: Record<string, string> = {
    "skills/pdf/SKILL.md": PDF_SKILL_MD,
    "skills/pdf/scripts/fill.py": "print(1)",
    "skills/docx/SKILL.md": "---\nname: docx\n---\n",
  }
): Record<string, Route> {
  return {
    "https://api.github.com/repos/anthropics/skills/commits/HEAD": () =>
      new Response(`${COMMIT}\n`),
    [`https://api.github.com/repos/anthropics/skills/git/trees/${COMMIT}`]:
      () => json(tree),
    [`https://raw.githubusercontent.com/anthropics/skills/${COMMIT}/`]: (
      url
    ) => {
      const repoPath = decodeURIComponent(
        url.slice(
          `https://raw.githubusercontent.com/anthropics/skills/${COMMIT}/`
            .length
        )
      );
      const content = files[repoPath];
      return content === undefined
        ? new Response("missing", { status: 404 })
        : new Response(content);
    },
  };
}

suite("SkillsRegistryClient", () => {
  suite("pure helpers", () => {
    test("toSkillSlug matches the skills.sh server algorithm", () => {
      assert.strictEqual(
        toSkillSlug("PDF Processing_Tool!"),
        "pdf-processing-tool"
      );
      assert.strictEqual(toSkillSlug("  --a--b--  "), "a-b");
    });

    test("sanitizeRegistryText strips escapes and control characters", () => {
      assert.strictEqual(
        sanitizeRegistryText(
          "\x1b[31mred\x1b[0m\nline\x07 two\x1b]0;title\x07"
        ),
        "red line two"
      );
      assert.strictEqual(sanitizeRegistryText("abcdef", 4), "abc…");
    });

    test("toSkillRelativePath rejects traversal and unsafe segments", () => {
      assert.strictEqual(
        toSkillRelativePath("skills/pdf/a/b.md", "skills/pdf"),
        "a/b.md"
      );
      assert.strictEqual(
        toSkillRelativePath("skills/pdfx/a.md", "skills/pdf"),
        null
      );
      assert.strictEqual(
        toSkillRelativePath("skills/pdf/../x", "skills/pdf"),
        null
      );
      assert.strictEqual(
        toSkillRelativePath("skills/pdf/a\\..\\x", "skills/pdf"),
        null
      );
      assert.strictEqual(
        toSkillRelativePath("skills/pdf/nul.txt", "skills/pdf"),
        null
      );
      assert.strictEqual(
        toSkillRelativePath("skills/pdf/C:x", "skills/pdf"),
        null
      );
      assert.strictEqual(
        toSkillRelativePath("skills/pdf/trailing.", "skills/pdf"),
        null
      );
      assert.strictEqual(toSkillRelativePath("SKILL.md", ""), "SKILL.md");
    });

    test("selectSkillFiles skips symlinks and excluded folders", () => {
      const files = selectSkillFiles(PDF_TREE.tree, "skills/pdf");
      assert.deepStrictEqual(
        files.map((file) => file.path),
        ["SKILL.md", "scripts/fill.py"]
      );
    });

    test("selectSkillFiles refuses an unsafe path instead of skipping it", () => {
      assert.throws(
        () =>
          selectSkillFiles(
            [{ path: "skills/pdf/con.md", type: "blob", size: 1 }],
            "skills/pdf"
          ),
        /will not write/
      );
    });

    test("selectSkillFiles enforces the size and count limits", () => {
      assert.throws(
        () =>
          selectSkillFiles(
            [
              {
                path: "s/big.bin",
                type: "blob",
                size: SKILL_INSTALL_LIMITS.MAX_FILE_BYTES + 1,
              },
            ],
            "s"
          ),
        /larger than/
      );
      const many = Array.from(
        { length: SKILL_INSTALL_LIMITS.MAX_FILES + 1 },
        (_, index) => ({ path: `s/f${index}.md`, type: "blob", size: 1 })
      );
      assert.throws(() => selectSkillFiles(many, "s"), /more than/);
    });

    test("rankSkillMdCandidates puts the folder named for the slug first", () => {
      assert.deepStrictEqual(
        rankSkillMdCandidates(PDF_TREE.tree, "anthropics/skills", "pdf"),
        ["skills/pdf/SKILL.md", "skills/docx/SKILL.md"]
      );
    });
  });

  suite("response parsing", () => {
    test("the top skills snapshot is validated like a search and sorted", () => {
      const snapshot = parseTopSkillsSnapshot({
        generatedAt: "2026-10-23T08:00:00.000Z",
        view: "all-time",
        skills: [
          {
            id: "a/b/low",
            source: "a/b",
            skillId: "low",
            name: "low",
            installs: 5,
          },
          {
            id: "../x",
            source: "../evil",
            skillId: "x",
            name: "x",
            installs: 9,
          },
          {
            id: "a/b/high",
            source: "a/b",
            skillId: "high",
            name: "high\x1b[31m",
            installs: 7,
          },
        ],
      });
      assert.strictEqual(snapshot.generatedAt, "2026-10-23T08:00:00.000Z");
      assert.deepStrictEqual(
        snapshot.skills.map((skill) => [skill.slug, skill.name]),
        [
          ["high", "high"],
          ["low", "low"],
        ]
      );
    });

    test("a missing, undated or malformed snapshot is no snapshot", () => {
      for (const data of [
        { generatedAt: null, skills: [] },
        { skills: [{ id: "a/b/c", source: "a/b", skillId: "c", installs: 1 }] },
        {
          generatedAt: "not a date",
          skills: [{ id: "a/b/c", source: "a/b", skillId: "c", installs: 1 }],
        },
        "nope",
        null,
      ]) {
        assert.deepStrictEqual(parseTopSkillsSnapshot(data), { skills: [] });
      }
    });

    test("the client reads the top skills from its snapshot without a request", () => {
      const fake = fakeFetch({});
      const registry = new SkillsShRegistryClient({
        fetch: fake.fetch,
        baseUrl: BASE,
        topSkillsSnapshot: {
          generatedAt: "2026-10-23T08:00:00.000Z",
          skills: [
            {
              id: "a/b/c",
              source: "a/b",
              skillId: "c",
              name: "c",
              installs: 1,
            },
          ],
        },
      });
      assert.deepStrictEqual(
        registry.getTopSkills().skills.map((skill) => skill.id),
        ["a/b/c"]
      );
      assert.strictEqual(fake.urls.length, 0);
    });

    test("search keeps valid entries and derives the slug", () => {
      const skills = parseSkillsSearchResponse({
        skills: [
          {
            id: "a/b/one",
            source: "a/b",
            skillId: "one",
            name: "One",
            installs: 12,
          },
          { id: "a/b/two", source: "a/b", name: "Two", installs: "lots" },
          {
            id: "a/b/one",
            source: "a/b",
            skillId: "one",
            name: "Dup",
            installs: 1,
          },
          { id: "x/../y", source: "../etc", skillId: "y", name: "Bad" },
          { id: "a/b/..", source: "a/b", skillId: "..", name: "Dot" },
          "not an object",
        ],
      });
      assert.deepStrictEqual(skills, [
        {
          id: "a/b/one",
          source: "a/b",
          slug: "one",
          name: "One",
          installs: 12,
        },
        { id: "a/b/two", source: "a/b", slug: "two", name: "Two", installs: 0 },
      ]);
    });

    test("search rejects an unexpected top-level shape, naming skills.sh", () => {
      assert.throws(
        () => parseSkillsSearchResponse({ results: [] }),
        (error: Error) =>
          error instanceof SkillsRegistryError &&
          /skills\.sh/.test(error.message)
      );
    });

    test("an unknown audit verdict counts as a warning", () => {
      const audits = parseSkillAuditResponse({
        audits: [
          {
            provider: "Socket",
            slug: "socket",
            status: "pass",
            summary: "No alerts",
          },
          { provider: "New Scanner", status: "mystery" },
          { status: "fail" },
        ],
      });
      assert.deepStrictEqual(audits, [
        {
          provider: "Socket",
          providerSlug: "socket",
          status: SKILL_AUDIT_STATUSES.PASS,
          summary: "No alerts",
        },
        {
          provider: "New Scanner",
          providerSlug: "new-scanner",
          status: SKILL_AUDIT_STATUSES.WARN,
        },
      ]);
    });
  });

  suite("skills.sh requests", () => {
    test("search sorts by installs and sends only the query", async () => {
      const { registry, urls } = client({
        [`${BASE}/api/search`]: () =>
          json({
            skills: [
              {
                id: "a/b/low",
                source: "a/b",
                skillId: "low",
                name: "low",
                installs: 1,
              },
              {
                id: "a/b/high",
                source: "a/b",
                skillId: "high",
                name: "high",
                installs: 9,
              },
            ],
          }),
      });
      const skills = await registry.searchSkills("  pdf ");
      assert.deepStrictEqual(
        skills.map((skill) => skill.slug),
        ["high", "low"]
      );
      assert.strictEqual(urls.length, 1);
      const url = new URL(urls[0]!);
      assert.strictEqual(url.searchParams.get("q"), "pdf");
    });

    test("a query shorter than two characters makes no request", async () => {
      const { registry, urls } = client({});
      assert.deepStrictEqual(await registry.searchSkills("x"), []);
      assert.strictEqual(urls.length, 0);
    });

    test("an HTTP error names skills.sh and carries the server's reason", async () => {
      const { registry } = client({
        [`${BASE}/api/search`]: () =>
          json(
            { error: "Query must be at least 2 characters" },
            { status: 400 }
          ),
      });
      await assert.rejects(
        registry.searchSkills("pdf"),
        /^SkillsRegistryError: skills\.sh search is unavailable \(HTTP 400\): Query must be at least 2 characters$/
      );
    });

    test("429 reports Retry-After", async () => {
      const { registry } = client({
        [`${BASE}/api/search`]: () =>
          new Response("slow down", {
            status: 429,
            headers: { "retry-after": "30" },
          }),
      });
      await assert.rejects(
        registry.searchSkills("pdf"),
        /skills\.sh is rate-limiting requests from this network; try again in 30 seconds/
      );
    });

    test("a network failure names skills.sh", async () => {
      const registry = new SkillsShRegistryClient({
        baseUrl: BASE,
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      });
      await assert.rejects(
        registry.searchSkills("pdf"),
        /skills\.sh search is unavailable: fetch failed/
      );
    });

    test("an audit 404 means not audited yet", async () => {
      const { registry } = client({
        [`${BASE}/api/v1/skills/audit/a/b/one`]: () =>
          new Response("{}", { status: 404 }),
      });
      assert.strictEqual(await registry.getSkillAudits("a/b", "one"), null);
    });

    test("batched audits report a failure per skill instead of throwing", async () => {
      const { registry } = client({
        [`${BASE}/api/v1/skills/audit/a/b/ok`]: () =>
          json({
            audits: [{ provider: "Socket", slug: "socket", status: "pass" }],
          }),
        [`${BASE}/api/v1/skills/audit/a/b/broken`]: () =>
          new Response("oops", { status: 500 }),
      });
      const results = await fetchSkillAuditsBatch(registry, [
        { source: "a/b", slug: "ok" },
        { source: "a/b", slug: "broken" },
      ]);
      assert.strictEqual(results[0]!.audits?.length, 1);
      assert.strictEqual(results[1]!.audits, null);
      assert.match(
        results[1]!.error ?? "",
        /skills\.sh security audits is unavailable \(HTTP 500\)/
      );
    });

    test("an invalid skill id is refused before any request", async () => {
      const { registry, urls } = client({});
      await assert.rejects(registry.getSkillAudits("../x", "y"), /Not a valid/);
      await assert.rejects(
        registry.resolveSkill("a/b", "../../x"),
        /Not a valid/
      );
      assert.strictEqual(urls.length, 0);
    });
  });

  suite("GitHub resolution and download", () => {
    test("resolves the folder whose frontmatter name slugs to the slug", async () => {
      const { registry } = client(githubRoutes());
      const location = await registry.resolveSkill("anthropics/skills", "pdf");
      assert.deepStrictEqual(location, {
        source: "anthropics/skills",
        slug: "pdf",
        commitSha: COMMIT,
        folderPath: "skills/pdf",
        skillMdPath: "skills/pdf/SKILL.md",
        name: "pdf",
        description: "Work with PDFs",
      });
    });

    test("falls back to frontmatter when the folder name differs", async () => {
      const tree = {
        tree: [{ path: "skills/processing/SKILL.md", type: "blob", size: 10 }],
      };
      const { registry } = client(
        githubRoutes(tree, {
          "skills/processing/SKILL.md": "---\nname: PDF Tools\n---\n",
        })
      );
      const location = await registry.resolveSkill(
        "anthropics/skills",
        "pdf-tools"
      );
      assert.strictEqual(location.folderPath, "skills/processing");
    });

    test("reports a skill that is not in the repository", async () => {
      const { registry } = client(githubRoutes());
      await assert.rejects(
        registry.resolveSkill("anthropics/skills", "nope"),
        /Could not find the "nope" skill in github\.com\/anthropics\/skills/
      );
    });

    test("a truncated tree is an error, not a partial search", async () => {
      const { registry } = client(
        githubRoutes({ ...PDF_TREE, truncated: true })
      );
      await assert.rejects(
        registry.resolveSkill("anthropics/skills", "pdf"),
        /GitHub truncated the repository tree/
      );
    });

    test("a GitHub rate limit names GitHub and the reset time", async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 600;
      const { registry } = client({
        "https://api.github.com/": () =>
          new Response("{}", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetAt),
            },
          }),
      });
      await assert.rejects(
        registry.resolveSkill("anthropics/skills", "pdf"),
        /GitHub is rate-limiting requests from this network; try again in 1[01] minutes/
      );
    });

    test("downloads the folder's files at the pinned commit", async () => {
      const { registry, urls } = client(githubRoutes());
      const location = await registry.resolveSkill("anthropics/skills", "pdf");
      const files = await registry.downloadSkill(location);
      assert.deepStrictEqual(
        files.map((file) => [file.path, Buffer.from(file.content).toString()]),
        [
          ["SKILL.md", PDF_SKILL_MD],
          ["scripts/fill.py", "print(1)"],
        ]
      );
      assert.ok(urls.every((url) => !url.includes("/HEAD/")));
      assert.strictEqual(
        urls.filter((url) => url.includes("/git/trees/")).length,
        1,
        "the commit's tree is fetched once and reused"
      );
    });

    test("refuses a location whose paths are inconsistent or unsafe", async () => {
      const { registry, urls } = client(githubRoutes());
      const valid: RegistrySkillLocation = {
        source: "anthropics/skills",
        slug: "pdf",
        commitSha: COMMIT,
        folderPath: "skills/pdf",
        skillMdPath: "skills/pdf/SKILL.md",
        name: "pdf",
      };
      for (const bad of [
        { ...valid, commitSha: "HEAD" },
        { ...valid, folderPath: "skills/../.." },
        { ...valid, skillMdPath: "skills/docx/SKILL.md" },
        { ...valid, skillMdPath: "skills/pdf/README.md" },
      ]) {
        await assert.rejects(registry.downloadSkill(bad), /not valid/);
      }
      assert.strictEqual(urls.length, 0);
    });
  });

  suite("update check", () => {
    const NEWER = "1111111111111111111111111111111111111111";
    const installed: InstalledRegistrySkill = {
      source: "anthropics/skills",
      slug: "pdf",
      commitSha: COMMIT,
      skillMdPath: "skills/pdf/SKILL.md",
      files: { "SKILL.md": "aaa", "scripts/fill.py": "bbb" },
    };
    const treeAt = (entries: Array<[string, string]>) => ({
      tree: [
        { path: "README.md", type: "blob", size: 1, sha: "readme" },
        ...entries.map(([repoPath, sha]) => ({
          path: repoPath,
          type: "blob",
          size: 1,
          sha,
        })),
      ],
    });

    function updateRoutes(
      head: string,
      tree: unknown,
      files: Record<string, string> = {}
    ): Record<string, Route> {
      return {
        "https://api.github.com/repos/anthropics/skills/commits/HEAD": () =>
          new Response(`${head}\n`),
        [`https://api.github.com/repos/anthropics/skills/git/trees/${head}`]:
          () => json(tree),
        [`https://raw.githubusercontent.com/anthropics/skills/${head}/`]: (
          url
        ) => {
          const content =
            files[
              decodeURIComponent(
                url.slice(
                  `https://raw.githubusercontent.com/anthropics/skills/${head}/`
                    .length
                )
              )
            ];
          return content === undefined
            ? new Response("missing", { status: 404 })
            : new Response(content);
        },
      };
    }

    test("an unchanged HEAD is up to date after one request", async () => {
      const { registry, urls } = client(updateRoutes(COMMIT, treeAt([])));
      assert.deepStrictEqual(await registry.checkForUpdate(installed), {
        status: SKILL_UPDATE_STATUSES.UP_TO_DATE,
        latestCommitSha: COMMIT,
      });
      assert.strictEqual(urls.length, 1);
    });

    test("commits elsewhere in the repository are not an update", async () => {
      const { registry } = client(
        updateRoutes(
          NEWER,
          treeAt([
            ["skills/pdf/SKILL.md", "aaa"],
            ["skills/pdf/scripts/fill.py", "bbb"],
            ["skills/docx/SKILL.md", "changed"],
          ])
        )
      );
      assert.deepStrictEqual(await registry.checkForUpdate(installed), {
        status: SKILL_UPDATE_STATUSES.UP_TO_DATE,
        latestCommitSha: NEWER,
      });
    });

    test("an edited, added or removed file in the folder is an update", async () => {
      for (const entries of [
        [
          ["skills/pdf/SKILL.md", "aaa"],
          ["skills/pdf/scripts/fill.py", "edited"],
        ],
        [
          ["skills/pdf/SKILL.md", "aaa"],
          ["skills/pdf/scripts/fill.py", "bbb"],
          ["skills/pdf/new.md", "ccc"],
        ],
        [["skills/pdf/SKILL.md", "aaa"]],
      ] as Array<Array<[string, string]>>) {
        const { registry } = client(updateRoutes(NEWER, treeAt(entries)));
        assert.deepStrictEqual(
          await registry.checkForUpdate(installed),
          {
            status: SKILL_UPDATE_STATUSES.UPDATE_AVAILABLE,
            latestCommitSha: NEWER,
          },
          JSON.stringify(entries)
        );
      }
    });

    test("a skill whose folder moved is found again by its frontmatter", async () => {
      const { registry } = client(
        updateRoutes(NEWER, treeAt([["pdf/SKILL.md", "aaa"]]), {
          "pdf/SKILL.md": "---\nname: pdf\n---\n",
        })
      );
      assert.strictEqual(
        (await registry.checkForUpdate(installed)).status,
        SKILL_UPDATE_STATUSES.UPDATE_AVAILABLE
      );
    });

    test("a skill gone from its repository is reported as not found", async () => {
      const { registry } = client(
        updateRoutes(NEWER, treeAt([["skills/docx/SKILL.md", "x"]]), {
          "skills/docx/SKILL.md": "---\nname: docx\n---\n",
        })
      );
      assert.strictEqual(
        (await registry.checkForUpdate(installed)).status,
        SKILL_UPDATE_STATUSES.NOT_FOUND
      );
    });

    test("skills from one repository share its HEAD lookup", async () => {
      const { registry, urls } = client(updateRoutes(COMMIT, treeAt([])));
      const outcomes = await checkSkillUpdatesBatch(registry, [
        installed,
        { ...installed, slug: "docx", skillMdPath: "skills/docx/SKILL.md" },
      ]);
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome.status),
        [SKILL_UPDATE_STATUSES.UP_TO_DATE, SKILL_UPDATE_STATUSES.UP_TO_DATE]
      );
      assert.strictEqual(
        urls.filter((url) => url.endsWith("/commits/HEAD")).length,
        1
      );
    });

    test("a failed check becomes that skill's error, not a throw", async () => {
      const { registry } = client({
        "https://api.github.com/": () => new Response("", { status: 500 }),
      });
      const [outcome] = await checkSkillUpdatesBatch(registry, [installed]);
      assert.strictEqual(outcome?.status, SKILL_UPDATE_STATUSES.FAILED);
      assert.match(
        "error" in outcome! ? outcome.error : "",
        /GitHub lookup of anthropics\/skills is unavailable \(HTTP 500\)/
      );
    });
  });
});
