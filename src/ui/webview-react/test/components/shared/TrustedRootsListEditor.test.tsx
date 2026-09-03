import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrustedRootsListEditor } from "@components/shared/TrustedRootsListEditor";

describe("TrustedRootsListEditor", () => {
  it("adds valid manual paths and rejects empty or obviously invalid values", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <TrustedRootsListEditor
        entries={[]}
        showDecisionStatus={false}
        onAdd={onAdd}
        onBrowse={() => {}}
        onRemove={() => {}}
      />
    );

    const input = screen.getByRole("textbox", {
      name: "External directory path",
    });
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Path cannot be empty."
    );

    await user.type(input, "not-a-path");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("directory separator");

    await user.clear(input);
    await user.type(input, "  C:\\tools  ");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onAdd).toHaveBeenCalledWith("C:\\tools");
  });

  it("shows decision status and flips a denied root without removing it", async () => {
    const user = userEvent.setup();
    const onDecisionChange = vi.fn();
    const onRemove = vi.fn();
    render(
      <TrustedRootsListEditor
        entries={[{ path: "/shared/logs", decision: "deny" }]}
        showDecisionStatus
        onAdd={() => {}}
        onBrowse={() => {}}
        onRemove={onRemove}
        onDecisionChange={onDecisionChange}
      />
    );

    expect(screen.getByText("Denied")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Allow /shared/logs" })
    );
    expect(onDecisionChange).toHaveBeenCalledWith("/shared/logs", "allow");
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("hides decision status and controls for user-scope entries", () => {
    render(
      <TrustedRootsListEditor
        entries={[{ path: "/home/user/logs" }]}
        showDecisionStatus={false}
        onAdd={() => {}}
        onBrowse={() => {}}
        onRemove={() => {}}
        onDecisionChange={() => {}}
      />
    );

    expect(screen.getByText("/home/user/logs")).toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Allow /i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Deny /i })
    ).not.toBeInTheDocument();
  });
});
