import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("@hooks/useMessageHandler", () => ({
  sendMessage: sendMessageMock,
}));

import {
  SkillOriginBadge,
  SkillsRegistryPanel,
  formatSkillInstalls,
  filterRegistrySkills,
  getWorstSkillAudit,
  needsRiskAcknowledgement,
} from "@components/settings/SkillsRegistryPanel";
import { useSkillsRegistryStore } from "@store/useSkillsRegistryStore";
import {
  DATA_SOURCES,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  SKILL_AUDIT_STATUSES,
  SKILL_UPDATE_STATUSES,
  SPECIAL_TARGET_IDS,
} from "@root/types/DashboardConstants";
import type {
  ManagedFile,
  ManagedFileLocation,
  RegistrySkillAuditResult,
  RegistrySkillEntry,
  RegistrySkillLocation,
  SkillUpdateCheckResult,
} from "@root/types/WebviewMessageTypes";

const PDF: RegistrySkillEntry = {
  id: "anthropics/skills/pdf",
  source: "anthropics/skills",
  slug: "pdf",
  name: "pdf",
  installs: 215435,
};
const DOCX: RegistrySkillEntry = {
  id: "anthropics/skills/docx",
  source: "anthropics/skills",
  slug: "docx",
  name: "docx",
  installs: 12,
};
const PDF_LOCATION: RegistrySkillLocation = {
  source: "anthropics/skills",
  slug: "pdf",
  commitSha: "dbd4588f9e1033efb41dad4bef2f7947c8993d44",
  folderPath: "skills/pdf",
  skillMdPath: "skills/pdf/SKILL.md",
  name: "pdf",
};

const PDF_COPY: ManagedFileLocation = {
  harnessId: SPECIAL_TARGET_IDS.CTRLYOKE,
  scope: SETTING_SCOPES.WORKSPACE,
  path: "C:/repo/.ctrlyoke/skills/pdf",
  origin: {
    registry: DATA_SOURCES.SKILLS_SH.host,
    source: PDF_LOCATION.source,
    slug: PDF_LOCATION.slug,
    commitSha: PDF_LOCATION.commitSha,
    skillMdPath: PDF_LOCATION.skillMdPath,
    installedAt: "2026-10-23T13:04:40.402Z",
  },
};
const PDF_FILE: ManagedFile = {
  name: "pdf",
  displayName: "Pdf",
  type: "skill",
  locations: [PDF_COPY],
};

const initialState = useSkillsRegistryStore.getState();

function sentOfType(type: string) {
  return sendMessageMock.mock.calls.filter(([sent]) => sent === type);
}

function renderPanel(managedFiles: ManagedFile[] = []) {
  return render(
    <SkillsRegistryPanel
      activeScope={SETTING_SCOPES.WORKSPACE}
      managedFiles={managedFiles}
      skillsDirectory="C:/repo/.ctrlyoke/skills"
    />
  );
}

/** Open the tab, type a query and let the debounced search go out. */
function searchFor(query: string) {
  if (!useSkillsRegistryStore.getState().isOpen) {
    fireEvent.click(
      screen.getByRole("button", { name: DATA_SOURCES.SKILLS_SH.label })
    );
  }
  fireEvent.change(
    screen.getByLabelText(`Search ${DATA_SOURCES.SKILLS_SH.label}`),
    { target: { value: query } }
  );
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

function answerSearch(skills: RegistrySkillEntry[], error?: string) {
  act(() => {
    const { latestRequestId, setSearchResult } =
      useSkillsRegistryStore.getState();
    setSearchResult(latestRequestId, skills, error);
  });
}

describe("SkillsRegistryPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMessageMock.mockReset();
    useSkillsRegistryStore.setState(initialState, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names skills.sh as the source and asks for nothing until the tab is opened", () => {
    renderPanel();
    const tab = screen.getByRole("button", {
      name: DATA_SOURCES.SKILLS_SH.label,
    });
    expect(tab.getAttribute("title")).toContain(
      DATA_SOURCES.SKILLS_SH.operator
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(sendMessageMock).not.toHaveBeenCalled();

    fireEvent.click(tab);
    expect(
      screen.getByRole("link", { name: DATA_SOURCES.SKILLS_SH.host })
    ).toBeTruthy();
    expect(screen.getByText(/your search text is sent there/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // Opening asks the extension for the bundled top skills: an empty query,
    // which reaches no network.
    expect(sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH)).toEqual([
      [
        MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH,
        { requestId: 1, query: "" },
      ],
    ]);
    expect(screen.getByText("Loading top skills…")).toBeTruthy();

    // Without a snapshot the tab falls back to asking for a search.
    answerSearch([]);
    expect(screen.getByText(/Type at least 2 characters/)).toBeTruthy();
  });

  describe("top skills", () => {
    function openTop(skills: RegistrySkillEntry[]) {
      renderPanel();
      fireEvent.click(
        screen.getByRole("button", { name: DATA_SOURCES.SKILLS_SH.label })
      );
      act(() => {
        vi.advanceTimersByTime(0);
      });
      act(() => {
        const { latestRequestId, setSearchResult } =
          useSkillsRegistryStore.getState();
        setSearchResult(
          latestRequestId,
          skills,
          undefined,
          "2026-10-23T08:00:00.000Z"
        );
      });
    }

    it("shows the dated snapshot before a search, and again once it is cleared", () => {
      openTop([PDF, DOCX]);
      expect(
        screen.getByText(/Top skills on skills\.sh · as of Oct 23, 2026/)
      ).toBeTruthy();
      expect(screen.getByText("pdf")).toBeTruthy();

      searchFor("excel");
      answerSearch([]);
      expect(screen.queryByText(/Top skills on/)).toBeNull();

      // Clearing the search asks for the snapshot again, still with no
      // query text.
      sendMessageMock.mockClear();
      searchFor("");
      expect(sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH)).toEqual([
        [
          MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH,
          { requestId: 3, query: "" },
        ],
      ]);
    });

    it("does not ask again while the snapshot is showing", () => {
      openTop([PDF]);
      sendMessageMock.mockClear();
      searchFor("p");
      expect(
        sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH)
      ).toHaveLength(0);
      expect(screen.getByText(/Top skills on/)).toBeTruthy();
    });

    it("filters by install count", () => {
      openTop([PDF, DOCX]);
      fireEvent.click(screen.getByRole("button", { name: "100K+" }));
      expect(screen.getByText("pdf")).toBeTruthy();
      expect(screen.queryByText("docx")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Any" }));
      expect(screen.getByText("docx")).toBeTruthy();
    });

    it("Audits passed fetches every result's audits and keeps only all-pass skills", () => {
      const skills = Array.from({ length: 30 }, (_, index) => ({
        ...PDF,
        id: `a/b/skill-${index}`,
        source: "a/b",
        slug: `skill-${index}`,
        name: `skill-${index}`,
      }));
      openTop(skills);
      sendMessageMock.mockClear();
      fireEvent.click(screen.getByRole("button", { name: /Audits passed/ }));

      // The first page's ten were already requested; the other twenty go out
      // now, at most 25 to a message.
      const batches = sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_AUDITS);
      expect(batches.map(([, payload]) => payload.skills.length)).toEqual([20]);
      expect(
        screen.getByText(/Checking audits for 30 more skills/)
      ).toBeTruthy();

      act(() => {
        useSkillsRegistryStore.getState().setAuditResults(
          skills.map((skill, index) => ({
            source: skill.source,
            slug: skill.slug,
            audits:
              index === 3
                ? [
                    {
                      provider: "Socket",
                      providerSlug: "socket",
                      status: "pass" as const,
                    },
                  ]
                : index === 4
                  ? [
                      {
                        provider: "Snyk",
                        providerSlug: "snyk",
                        status: "warn" as const,
                      },
                    ]
                  : null,
          }))
        );
      });
      expect(screen.getByText("skill-3")).toBeTruthy();
      expect(screen.queryByText("skill-4")).toBeNull();
      expect(screen.queryByText("skill-0")).toBeNull();
      expect(screen.queryByText(/Checking audits for/)).toBeNull();
    });
  });

  it("filters out results whose audits are pending, failed or not all pass", () => {
    const audits = {
      [PDF.id]: {
        source: PDF.source,
        slug: PDF.slug,
        audits: [
          {
            provider: "Socket",
            providerSlug: "socket",
            status: SKILL_AUDIT_STATUSES.PASS,
          },
        ],
      },
      [DOCX.id]: { loading: true as const },
    };
    expect(filterRegistrySkills([PDF, DOCX], audits, 0, true)).toEqual({
      entries: [PDF],
      pendingAudits: 1,
    });
    expect(filterRegistrySkills([PDF, DOCX], audits, 100, false)).toEqual({
      entries: [PDF],
      pendingAudits: 0,
    });
  });

  it("debounces the search, shows loading, then results with audits requested", () => {
    renderPanel();
    searchFor("pdf");
    expect(sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH)).toEqual([
      [
        MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH,
        { requestId: 1, query: "pdf" },
      ],
    ]);
    expect(screen.getByText(/Searching skills\.sh/)).toBeTruthy();

    answerSearch([PDF, DOCX]);
    expect(screen.getByText("215.4K installs on skills.sh")).toBeTruthy();
    expect(sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_AUDITS)).toEqual([
      [
        MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_AUDITS,
        {
          skills: [
            { source: "anthropics/skills", slug: "pdf" },
            { source: "anthropics/skills", slug: "docx" },
          ],
        },
      ],
    ]);
    expect(screen.getAllByText("Checking audits")).toHaveLength(2);

    act(() => {
      useSkillsRegistryStore.getState().setAuditResults([
        {
          source: PDF.source,
          slug: PDF.slug,
          audits: [
            { provider: "Socket", providerSlug: "socket", status: "pass" },
            { provider: "Snyk", providerSlug: "snyk", status: "warn" },
          ],
        },
        { source: DOCX.source, slug: DOCX.slug, audits: null },
      ]);
    });
    const warning = screen.getByRole("link", { name: /Audit warning/ });
    expect(warning.getAttribute("href")).toBe(
      "https://skills.sh/anthropics/skills/pdf/security/snyk"
    );
    expect(screen.getByRole("link", { name: /Not audited/ })).toBeTruthy();
  });

  it("ignores a stale search answer", () => {
    renderPanel();
    searchFor("pd");
    searchFor("pdf");
    act(() => {
      useSkillsRegistryStore.getState().setSearchResult(1, [DOCX]);
    });
    expect(screen.queryByText("docx")).toBeNull();
    answerSearch([PDF]);
    expect(screen.getByText("pdf")).toBeTruthy();
  });

  it("shows a search failure as a skills.sh error", () => {
    renderPanel();
    searchFor("pdf");
    answerSearch([], "skills.sh search is unavailable (HTTP 503)");
    expect(
      screen.getByText("skills.sh search is unavailable (HTTP 503)")
    ).toBeTruthy();
  });

  it("marks the installed copy of a result as Installed", () => {
    renderPanel([PDF_FILE]);
    searchFor("pdf");
    answerSearch([PDF, DOCX]);
    const installed = screen.getByRole("button", { name: "Installed" });
    expect((installed as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
  });

  it("does not offer a result whose folder name a different skill already uses", () => {
    renderPanel([
      {
        ...PDF_FILE,
        locations: [{ ...PDF_COPY, origin: undefined }],
      },
    ]);
    searchFor("pdf");
    answerSearch([PDF]);
    const button = screen.getByRole("button", { name: "Name in use" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toMatch(/Delete or rename it/);
  });

  describe("updates", () => {
    const NEWER = "1111111111111111111111111111111111111111";
    const NEWER_LOCATION = { ...PDF_LOCATION, commitSha: NEWER };

    function answerUpdateCheck(
      overrides: Partial<SkillUpdateCheckResult> = {}
    ) {
      act(() => {
        useSkillsRegistryStore.getState().setUpdateCheckResults([
          {
            path: PDF_COPY.path,
            scope: SETTING_SCOPES.WORKSPACE,
            source: PDF.source,
            slug: PDF.slug,
            status: SKILL_UPDATE_STATUSES.UPDATE_AVAILABLE,
            latestCommitSha: NEWER,
            localChanges: [],
            ...overrides,
          },
        ]);
      });
    }

    it("checks for updates only when asked, and summarizes the answer", () => {
      renderPanel([PDF_FILE]);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(sendMessageMock).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("button", { name: /Check for updates/ })
      );
      expect(
        sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_UPDATE_CHECK)
      ).toHaveLength(1);
      expect(screen.getByText("Checking 1 skill on GitHub…")).toBeTruthy();

      answerUpdateCheck();
      expect(screen.getByText("1 update available")).toBeTruthy();
      answerUpdateCheck({ status: SKILL_UPDATE_STATUSES.UP_TO_DATE });
      expect(screen.getByText("Up to date")).toBeTruthy();
    });

    it("hides the update check when nothing came from skills.sh", () => {
      renderPanel([
        { ...PDF_FILE, locations: [{ ...PDF_COPY, origin: undefined }] },
      ]);
      expect(
        screen.queryByRole("button", { name: /Check for updates/ })
      ).toBeNull();
    });

    it("offers Update on the result and replaces the copy in its own scope", () => {
      renderPanel([PDF_FILE]);
      answerUpdateCheck();
      searchFor("pdf");
      answerSearch([PDF]);
      act(() => {
        useSkillsRegistryStore.getState().setAuditResults([
          {
            source: PDF.source,
            slug: PDF.slug,
            audits: [
              { provider: "Socket", providerSlug: "socket", status: "pass" },
            ],
          },
        ]);
      });
      fireEvent.click(screen.getByRole("button", { name: "Update" }));
      const dialog = screen.getByRole("dialog", { name: "Update pdf?" });
      act(() => {
        useSkillsRegistryStore
          .getState()
          .setLocationResult(PDF.source, PDF.slug, NEWER_LOCATION);
      });
      expect(
        within(dialog)
          .getByRole("link", { name: /Compare the commits/ })
          .getAttribute("href")
      ).toBe(
        `https://github.com/anthropics/skills/compare/${PDF_LOCATION.commitSha}...${NEWER}`
      );

      fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
      expect(sentOfType(MESSAGE_TYPES.INSTALL_REGISTRY_SKILL)).toEqual([
        [
          MESSAGE_TYPES.INSTALL_REGISTRY_SKILL,
          {
            location: NEWER_LOCATION,
            scope: SETTING_SCOPES.WORKSPACE,
            replace: true,
          },
        ],
      ]);

      act(() => {
        useSkillsRegistryStore
          .getState()
          .setInstallResult(PDF.source, PDF.slug);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(useSkillsRegistryStore.getState().updateCheck.results).toEqual({});
      expect(useSkillsRegistryStore.getState().locations[PDF.id]).toBe(
        undefined
      );
    });

    it("always looks up the newest commit for an update", () => {
      renderPanel([PDF_FILE]);
      act(() => {
        useSkillsRegistryStore
          .getState()
          .setLocationResult(PDF.source, PDF.slug, PDF_LOCATION);
      });
      answerUpdateCheck();
      render(<SkillOriginBadge location={PDF_COPY} name="Pdf" />);
      fireEvent.click(screen.getByRole("button", { name: /Update available/ }));
      expect(
        sentOfType(MESSAGE_TYPES.REQUEST_REGISTRY_SKILL_LOCATION)
      ).toHaveLength(1);
      expect(screen.getByRole("dialog", { name: "Update Pdf?" })).toBeTruthy();
    });

    it("lists local edits and needs consent to replace them", () => {
      renderPanel([PDF_FILE]);
      answerUpdateCheck({ localChanges: ["SKILL.md", "scripts/fill.py"] });
      render(<SkillOriginBadge location={PDF_COPY} />);
      fireEvent.click(screen.getByRole("button", { name: /Update available/ }));
      const dialog = screen.getByRole("dialog", { name: "Update pdf?" });
      act(() => {
        const store = useSkillsRegistryStore.getState();
        store.setLocationResult(PDF.source, PDF.slug, NEWER_LOCATION);
        store.setAuditResults([
          {
            source: PDF.source,
            slug: PDF.slug,
            audits: [
              { provider: "Socket", providerSlug: "socket", status: "pass" },
            ],
          },
        ]);
      });
      expect(within(dialog).getByText(/You changed 2 files/)).toBeTruthy();
      expect(within(dialog).getByText("scripts/fill.py")).toBeTruthy();
      const update = within(dialog).getByRole("button", {
        name: "Update",
      }) as HTMLButtonElement;
      expect(update.disabled).toBe(true);
      fireEvent.click(
        within(dialog).getByRole("checkbox", {
          name: "Replace my local changes.",
        })
      );
      expect(update.disabled).toBe(false);
    });

    it("badges a skills.sh copy and reports what the check found", () => {
      render(<SkillOriginBadge location={PDF_COPY} />);
      expect(
        screen.getByRole("link", { name: DATA_SOURCES.SKILLS_SH.label })
      ).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
      answerUpdateCheck({ status: SKILL_UPDATE_STATUSES.NOT_FOUND });
      expect(screen.getByText("Removed upstream")).toBeTruthy();
      answerUpdateCheck({
        status: SKILL_UPDATE_STATUSES.FAILED,
        error: "GitHub is rate-limiting requests",
      });
      expect(
        screen.getByText("Update check failed").getAttribute("title")
      ).toBe("GitHub is rate-limiting requests");
    });

    it("renders nothing for a copy that did not come from skills.sh", () => {
      const { container } = render(
        <SkillOriginBadge location={{ ...PDF_COPY, origin: undefined }} />
      );
      expect(container.textContent).toBe("");
    });
  });

  it("pages through results ten at a time", () => {
    renderPanel();
    searchFor("pdf");
    answerSearch(
      Array.from({ length: 12 }, (_, index) => ({
        ...PDF,
        id: `a/b/skill-${index}`,
        source: "a/b",
        slug: `skill-${index}`,
        name: `skill-${index}`,
      }))
    );
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(screen.queryByText("skill-10")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("skill-10")).toBeTruthy();
  });

  describe("install confirmation", () => {
    function openReview(audits: RegistrySkillAuditResultInput) {
      renderPanel();
      searchFor("pdf");
      answerSearch([PDF]);
      act(() => {
        useSkillsRegistryStore
          .getState()
          .setAuditResults([{ source: PDF.source, slug: PDF.slug, ...audits }]);
      });
      fireEvent.click(screen.getByRole("button", { name: "Import" }));
      return screen.getByRole("dialog", { name: "Install pdf?" });
    }

    type RegistrySkillAuditResultInput = Pick<
      RegistrySkillAuditResult,
      "audits" | "error"
    >;

    it("requests the GitHub location and installs the reviewed commit", () => {
      const dialog = openReview({
        audits: [
          { provider: "Socket", providerSlug: "socket", status: "pass" },
        ],
      });
      expect(sentOfType(MESSAGE_TYPES.REQUEST_REGISTRY_SKILL_LOCATION)).toEqual(
        [
          [
            MESSAGE_TYPES.REQUEST_REGISTRY_SKILL_LOCATION,
            { source: PDF.source, slug: PDF.slug },
          ],
        ]
      );
      const install = within(dialog).getByRole("button", { name: "Install" });
      expect((install as HTMLButtonElement).disabled).toBe(true);

      act(() => {
        useSkillsRegistryStore
          .getState()
          .setLocationResult(PDF.source, PDF.slug, PDF_LOCATION);
      });
      expect(
        within(dialog)
          .getByRole("link", { name: /SKILL\.md/ })
          .getAttribute("href")
      ).toBe(
        `https://github.com/anthropics/skills/blob/${PDF_LOCATION.commitSha}/skills/pdf/SKILL.md`
      );
      expect(within(dialog).getByText("C:/repo/.ctrlyoke/skills")).toBeTruthy();
      expect(within(dialog).queryByRole("checkbox")).toBeNull();

      fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
      expect(sentOfType(MESSAGE_TYPES.INSTALL_REGISTRY_SKILL)).toEqual([
        [
          MESSAGE_TYPES.INSTALL_REGISTRY_SKILL,
          { location: PDF_LOCATION, scope: SETTING_SCOPES.WORKSPACE },
        ],
      ]);

      act(() => {
        useSkillsRegistryStore
          .getState()
          .setInstallResult(PDF.source, PDF.slug);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it.each([
      [
        "a warning",
        {
          audits: [
            {
              provider: "Snyk",
              providerSlug: "snyk",
              status: SKILL_AUDIT_STATUSES.WARN,
            },
          ],
        },
      ],
      ["no audit yet", { audits: null }],
      [
        "unavailable audits",
        { audits: null, error: "skills.sh security audits is unavailable" },
      ],
    ] as const)("needs a second confirmation for %s", (_label, audits) => {
      const dialog = openReview(audits as RegistrySkillAuditResultInput);
      act(() => {
        useSkillsRegistryStore
          .getState()
          .setLocationResult(PDF.source, PDF.slug, PDF_LOCATION);
      });
      const install = within(dialog).getByRole("button", {
        name: "Install",
      }) as HTMLButtonElement;
      expect(install.disabled).toBe(true);
      fireEvent.click(within(dialog).getByRole("checkbox"));
      expect(install.disabled).toBe(false);
    });

    it("keeps the dialog open and shows an install failure", () => {
      const dialog = openReview({
        audits: [
          { provider: "Socket", providerSlug: "socket", status: "pass" },
        ],
      });
      act(() => {
        const store = useSkillsRegistryStore.getState();
        store.setLocationResult(PDF.source, PDF.slug, PDF_LOCATION);
        store.install(PDF_LOCATION, SETTING_SCOPES.WORKSPACE);
        store.setInstallResult(PDF.source, PDF.slug, "GitHub download failed");
      });
      expect(within(dialog).getByText("GitHub download failed")).toBeTruthy();
    });

    it("cannot install when the skill cannot be found on GitHub", () => {
      const dialog = openReview({
        audits: [
          { provider: "Socket", providerSlug: "socket", status: "pass" },
        ],
      });
      act(() => {
        useSkillsRegistryStore
          .getState()
          .setLocationResult(
            PDF.source,
            PDF.slug,
            undefined,
            "Could not find it"
          );
      });
      expect(within(dialog).getByText("Could not find it")).toBeTruthy();
      expect(
        (
          within(dialog).getByRole("button", {
            name: "Install",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
    });
  });
});

describe("skills registry helpers", () => {
  it("formats install counts as skills.sh data", () => {
    expect(formatSkillInstalls(1)).toBe("1 install on skills.sh");
    expect(formatSkillInstalls(12345)).toBe("12.3K installs on skills.sh");
  });

  it("picks the worst audit and gates install on anything but all-pass", () => {
    const pass = {
      provider: "A",
      providerSlug: "a",
      status: SKILL_AUDIT_STATUSES.PASS,
    };
    const fail = {
      provider: "B",
      providerSlug: "b",
      status: SKILL_AUDIT_STATUSES.FAIL,
    };
    expect(getWorstSkillAudit([pass, fail])).toBe(fail);
    expect(getWorstSkillAudit([])).toBeUndefined();
    const result = { source: "a/b", slug: "c" };
    expect(needsRiskAcknowledgement({ ...result, audits: [pass] })).toBe(false);
    expect(needsRiskAcknowledgement({ ...result, audits: [pass, fail] })).toBe(
      true
    );
    expect(needsRiskAcknowledgement({ ...result, audits: [] })).toBe(true);
    expect(needsRiskAcknowledgement({ loading: true })).toBe(true);
    expect(needsRiskAcknowledgement(undefined)).toBe(true);
  });
});
