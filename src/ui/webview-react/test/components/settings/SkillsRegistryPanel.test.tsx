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
  SkillsRegistryPanel,
  formatSkillInstalls,
  getWorstSkillAudit,
  needsRiskAcknowledgement,
} from "@components/settings/SkillsRegistryPanel";
import { useSkillsRegistryStore } from "@store/useSkillsRegistryStore";
import {
  DATA_SOURCES,
  MESSAGE_TYPES,
  SETTING_SCOPES,
  SKILL_AUDIT_STATUSES,
  SPECIAL_TARGET_IDS,
} from "@root/types/DashboardConstants";
import type {
  ManagedFile,
  RegistrySkillAuditResult,
  RegistrySkillEntry,
  RegistrySkillLocation,
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

  it("names skills.sh as the source and sends nothing until the tab is opened", () => {
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
    expect(screen.getByText(/Type at least 2 characters/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      sentOfType(MESSAGE_TYPES.REQUEST_SKILLS_REGISTRY_SEARCH)
    ).toHaveLength(0);
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

  it("marks a skill already in the active ctrlyoke scope as Imported", () => {
    renderPanel([
      {
        name: "pdf",
        displayName: "Pdf",
        type: "skill",
        locations: [
          {
            harnessId: SPECIAL_TARGET_IDS.CTRLYOKE,
            scope: SETTING_SCOPES.WORKSPACE,
            path: "C:/repo/.ctrlyoke/skills/pdf",
          },
        ],
      },
    ]);
    searchFor("pdf");
    answerSearch([PDF, DOCX]);
    const buttons = screen.getAllByRole("button", { name: /Import/ });
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Imported",
      "Import",
    ]);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
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
