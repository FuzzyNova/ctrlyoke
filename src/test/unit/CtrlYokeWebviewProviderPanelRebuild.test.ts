import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { suite, test } from "mocha";
import { CtrlYokeWebviewProvider } from "../../ui/CtrlYokeWebviewProvider";
import type { DashboardApplication } from "../../ui/DashboardApplication";
import { MESSAGE_TYPES } from "../../types/DashboardConstants";

// The panel's module-mount watchdog cannot reload its own page (a VS Code
// webview's content frame is an empty fake.html our HTML is written into), so
// it asks the provider to reassign webview.html. These cover that request and
// the cap that keeps a bundle that never mounts from rebuilding forever.

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");

class FakeWebview implements Pick<
  vscode.Webview,
  | "options"
  | "html"
  | "cspSource"
  | "onDidReceiveMessage"
  | "postMessage"
  | "asWebviewUri"
> {
  options: vscode.WebviewOptions = {};
  readonly cspSource = "vscode-webview://test";
  readonly htmlAssignments: string[] = [];
  private listener: ((message: unknown) => void) | undefined;

  get html(): string {
    return this.htmlAssignments[this.htmlAssignments.length - 1] ?? "";
  }

  set html(value: string) {
    this.htmlAssignments.push(value);
  }

  onDidReceiveMessage = ((listener: (message: unknown) => void) => {
    this.listener = listener;
    return new vscode.Disposable(() => {});
  }) as vscode.Webview["onDidReceiveMessage"];

  async postMessage(_message: unknown): Promise<boolean> {
    return true;
  }

  asWebviewUri(localResource: vscode.Uri): vscode.Uri {
    return localResource;
  }

  receive(message: unknown): void {
    this.listener?.(message);
  }
}

class FakeWebviewView implements Pick<
  vscode.WebviewView,
  "webview" | "onDidDispose"
> {
  readonly webview = new FakeWebview();

  onDidDispose = (() =>
    new vscode.Disposable(() => {})) as vscode.WebviewView["onDidDispose"];
}

class StubDashboardApplication implements Pick<
  DashboardApplication,
  | "settingsSync"
  | "serializer"
  | "router"
  | "secretRegistry"
  | "interactionPort"
> {
  readonly settingsSync = {
    sendInitialState: async () => {},
  } as unknown as DashboardApplication["settingsSync"];
  readonly serializer = {} as DashboardApplication["serializer"];
  readonly router = {} as DashboardApplication["router"];
  readonly secretRegistry = {} as DashboardApplication["secretRegistry"];
  readonly interactionPort = {} as DashboardApplication["interactionPort"];

  disposePanelClient(): void {}

  async routeClientMessage(): Promise<void> {}
}

function resolvePanel(): {
  provider: CtrlYokeWebviewProvider;
  view: FakeWebviewView;
} {
  const context = {
    extensionUri: vscode.Uri.file(REPOSITORY_ROOT),
  } as vscode.ExtensionContext;
  const provider = new CtrlYokeWebviewProvider(
    context,
    new StubDashboardApplication() as unknown as DashboardApplication
  );
  const view = new FakeWebviewView();
  void provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    new vscode.CancellationTokenSource().token
  );
  return { provider, view };
}

const PANEL_RELOAD_REQUEST = { type: MESSAGE_TYPES.PANEL_RELOAD_REQUEST };

suite("CtrlYokeWebviewProvider panel rebuild", () => {
  test("reassigns webview.html with a fresh document when the panel asks", () => {
    const { view } = resolvePanel();
    assert.strictEqual(view.webview.htmlAssignments.length, 1);

    view.webview.receive(PANEL_RELOAD_REQUEST);

    assert.strictEqual(view.webview.htmlAssignments.length, 2);
    assert.notStrictEqual(
      view.webview.htmlAssignments[1],
      view.webview.htmlAssignments[0],
      "the rebuilt document must differ (fresh nonce) or VS Code keeps the frame"
    );
  });

  test("stops rebuilding after two attempts that never produce a READY", () => {
    const { view } = resolvePanel();

    view.webview.receive(PANEL_RELOAD_REQUEST);
    view.webview.receive(PANEL_RELOAD_REQUEST);
    view.webview.receive(PANEL_RELOAD_REQUEST);

    assert.strictEqual(view.webview.htmlAssignments.length, 3);
  });

  test("a completed READY handshake restores the rebuild allowance", () => {
    const { provider, view } = resolvePanel();
    view.webview.receive(PANEL_RELOAD_REQUEST);
    view.webview.receive(PANEL_RELOAD_REQUEST);

    assert.strictEqual(provider.handlePanelReady("rebuilt-page"), true);
    view.webview.receive(PANEL_RELOAD_REQUEST);

    assert.strictEqual(view.webview.htmlAssignments.length, 4);
  });

  test("a rebuilt page's READY is handled even when it reuses an accepted id", () => {
    const { provider, view } = resolvePanel();
    assert.strictEqual(provider.handlePanelReady("page-1"), true);
    assert.strictEqual(provider.handlePanelReady("page-1"), false);

    view.webview.receive(PANEL_RELOAD_REQUEST);

    assert.strictEqual(provider.handlePanelReady("page-1"), true);
  });
});
