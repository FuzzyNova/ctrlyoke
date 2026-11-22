import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
}));

vi.mock("@messaging/sendMessage", () => ({
  sendMessage: sendMessageMock,
}));

import { CommunityTemplatesPage } from "@components/settings/CommunityTemplatesPage";
import { TemplatesSection } from "@components/settings/TemplatesSection";
import { useCommunityTemplatesStore } from "@store/communityTemplatesStore";
import { useUiStore, type TemplateInfo } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "@root/types/CtrlYokeSettings";
import type {
  CommunityTemplateEntry,
  FullGlobalSettings,
} from "@root/types/WebviewMessageTypes";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";

const REVIEW: CommunityTemplateEntry = {
  id: "octocat-review-branch",
  name: "Review Branch",
  description: "Review the current branch and fix what it finds.",
  author: "octocat",
  tags: ["review", "git"],
  file: "octocat-review-branch.ctrlyoke.yaml",
};

const FIX: CommunityTemplateEntry = {
  id: "alice-fix-tests",
  name: "Fix Tests",
  description: "Loop until the tests pass.",
  tags: ["testing"],
  file: "alice-fix-tests.ctrlyoke.yaml",
};

function installedTemplate(
  id: string,
  scope: SettingWriteScope = SETTING_SCOPES.USER
) {
  return {
    id: `custom:${scope}:${id}`,
    name: "Review Branch",
    description: "",
    isBuiltIn: false,
    source: scope,
    variables: [{ name: "testCommand", type: "text", default: "npm test" }],
  } satisfies TemplateInfo;
}

function seedIndex(templates: CommunityTemplateEntry[], error?: string) {
  useCommunityTemplatesStore.setState({
    templates,
    error,
    isLoading: false,
  });
}

function sent(type: string) {
  return sendMessageMock.mock.calls.filter(([sentType]) => sentType === type);
}

function resetStores() {
  useCommunityTemplatesStore.setState({
    templates: undefined,
    isLoading: false,
    error: undefined,
    query: "",
    installs: {},
  });
  useUiStore.setState({ templateCatalog: [] });
}

describe("CommunityTemplatesPage", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    resetStores();
  });
  afterEach(() => cleanup());

  it("downloads the index once, when the page first opens", () => {
    const { unmount } = render(
      <CommunityTemplatesPage activeScope="user" onSetDefaults={vi.fn()} />
    );
    expect(sent(MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX)).toEqual([
      [MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX, {}],
    ]);
    expect(screen.getByText(/Loading community templates/)).toBeVisible();

    act(() => useCommunityTemplatesStore.getState().setIndexResult([REVIEW]));
    unmount();
    render(
      <CommunityTemplatesPage activeScope="user" onSetDefaults={vi.fn()} />
    );
    expect(sent(MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX)).toHaveLength(
      1
    );
  });

  it("lists templates with author, tags and source, and filters them", () => {
    seedIndex([FIX, REVIEW]);
    render(
      <CommunityTemplatesPage activeScope="user" onSetDefaults={vi.fn()} />
    );
    const row = screen.getByTestId(`community-template-${REVIEW.id}`);
    expect(within(row).getByText("by octocat")).toBeInTheDocument();
    expect(within(row).getByText("git")).toBeInTheDocument();
    expect(
      within(row).getByRole("link", { name: "View source" })
    ).toHaveAttribute(
      "href",
      `https://github.com/FuzzyNova/ctrlyoke-templates/blob/main/templates/${REVIEW.file}`
    );
    expect(screen.getByRole("note")).toHaveTextContent(/third parties/);

    fireEvent.change(screen.getByLabelText("Filter community templates"), {
      target: { value: "testing" },
    });
    expect(screen.getByText("Fix Tests")).toBeInTheDocument();
    expect(screen.queryByText("Review Branch")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter community templates"), {
      target: { value: "nothing-matches" },
    });
    expect(screen.getByText(/No community templates match/)).toBeVisible();
  });

  it("installs into the active scope and shows Installed once the catalog has it", () => {
    seedIndex([REVIEW]);
    render(
      <CommunityTemplatesPage activeScope="workspace" onSetDefaults={vi.fn()} />
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Install Review Branch to Workspace templates",
      })
    );
    expect(sent(MESSAGE_TYPES.INSTALL_COMMUNITY_TEMPLATE)).toEqual([
      [
        MESSAGE_TYPES.INSTALL_COMMUNITY_TEMPLATE,
        { id: REVIEW.id, scope: "workspace" },
      ],
    ]);
    expect(
      screen.getByRole("button", { name: /Install Review Branch/ })
    ).toBeDisabled();

    act(() => {
      useCommunityTemplatesStore.getState().setInstallResult({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INSTALL_RESULT,
        id: REVIEW.id,
        scope: "workspace",
        success: true,
        localTemplateId: `custom:workspace:${REVIEW.id}`,
      });
      useUiStore.setState({
        templateCatalog: [installedTemplate(REVIEW.id, "workspace")],
      });
    });
    expect(
      screen.getByRole("button", {
        name: "Review Branch is installed in Workspace templates",
      })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set defaults" })).toBeVisible();
  });

  it("treats a copy in the other scope as not installed here", () => {
    seedIndex([REVIEW]);
    useUiStore.setState({
      templateCatalog: [installedTemplate(REVIEW.id, "workspace")],
    });
    render(
      <CommunityTemplatesPage activeScope="user" onSetDefaults={vi.fn()} />
    );
    expect(
      screen.getByRole("button", { name: /Install Review Branch to User/ })
    ).toBeEnabled();
  });

  it("shows an install failure on its row", () => {
    seedIndex([REVIEW]);
    render(
      <CommunityTemplatesPage activeScope="user" onSetDefaults={vi.fn()} />
    );
    act(() =>
      useCommunityTemplatesStore.getState().setInstallResult({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INSTALL_RESULT,
        id: REVIEW.id,
        scope: "user",
        success: false,
        error: "Template already exists: octocat-review-branch",
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Template already exists"
    );
    expect(
      screen.getByRole("button", { name: /Install Review Branch/ })
    ).toBeEnabled();
  });

  it("reports an offline index and refreshes on request", () => {
    render(
      <CommunityTemplatesPage activeScope="user" onSetDefaults={vi.fn()} />
    );
    act(() =>
      useCommunityTemplatesStore
        .getState()
        .setIndexResult([], "Could not reach cdn.jsdelivr.net")
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not reach cdn.jsdelivr.net"
    );
    sendMessageMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(sent(MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX)).toEqual([
      [MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX, { refresh: true }],
    ]);
  });

  it("says so when the library is empty", () => {
    seedIndex([]);
    render(
      <CommunityTemplatesPage activeScope="user" onSetDefaults={vi.fn()} />
    );
    expect(screen.getByText(/has no templates yet/)).toBeVisible();
  });
});

describe("TemplatesSection pages", () => {
  const postMessage = vi.fn();
  const settings: FullGlobalSettings = {
    settings: CTRLYOKE_SETTINGS_DEFAULTS,
    sources: {},
    isMultiRoot: false,
    templateVariableDefaultsByScope: { user: {}, workspace: {} },
  };

  beforeEach(() => {
    sendMessageMock.mockReset();
    postMessage.mockReset();
    resetStores();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
    const { globalSettings } = useSettingsStore.getState();
    useSettingsStore.setState({
      globalSettings: { ...globalSettings, workspaceRoot: "/repo" },
    });
  });
  afterEach(() => cleanup());

  function mount(scope: "user" | "workspace" = "user") {
    return render(
      <TemplatesSection
        settings={settings}
        activeScope={scope}
        onUpdate={vi.fn()}
        onReset={vi.fn()}
      />
    );
  }

  it("switches between Defaults and Discover with the page bar", () => {
    mount();
    expect(screen.getByTestId("templates-section")).toBeInTheDocument();
    expect(sent(MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX)).toHaveLength(
      0
    );

    fireEvent.click(screen.getByRole("tab", { name: "Discover" }));
    expect(screen.getByTestId("community-templates-page")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Community Templates" })
    ).toBeInTheDocument();
    expect(sent(MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX)).toHaveLength(
      1
    );

    fireEvent.click(screen.getByRole("tab", { name: "Defaults" }));
    expect(screen.getByTestId("templates-section")).toBeInTheDocument();
  });

  it("Set defaults opens the installed template's card on Defaults", () => {
    seedIndex([REVIEW]);
    useUiStore.setState({ templateCatalog: [installedTemplate(REVIEW.id)] });
    useCommunityTemplatesStore.setState({
      installs: {
        [`user:${REVIEW.id}`]: { localTemplateId: `custom:user:${REVIEW.id}` },
      },
    });
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Discover" }));
    fireEvent.click(screen.getByRole("button", { name: "Set defaults" }));

    expect(
      screen.getByTestId(`template-card-custom:user:${REVIEW.id}`)
    ).toBeInTheDocument();
  });

  it("asks for a workspace before installing Workspace templates", () => {
    const { globalSettings } = useSettingsStore.getState();
    useSettingsStore.setState({
      globalSettings: { ...globalSettings, workspaceRoot: "" },
    });
    mount("workspace");
    fireEvent.click(screen.getByRole("tab", { name: "Discover" }));
    expect(
      screen.getByText("Open a workspace to install Workspace templates.")
    ).toBeInTheDocument();
    expect(sent(MESSAGE_TYPES.REQUEST_COMMUNITY_TEMPLATE_INDEX)).toHaveLength(
      0
    );
  });
});
