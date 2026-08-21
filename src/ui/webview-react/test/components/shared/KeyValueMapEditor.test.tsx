import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyValueMapEditor } from "@components/shared/KeyValueMapEditor";
import { useSecretRegistryStore } from "@store/secretRegistryStore";

afterEach(() => {
  cleanup();
  useSecretRegistryStore.getState().resetSecretRegistry();
});

describe("KeyValueMapEditor", () => {
  it("does not commit on every keystroke, only on blur", () => {
    const onChange = vi.fn();
    render(
      <KeyValueMapEditor
        label="Environment variables"
        value={{ FIRST: "one", SECOND: "two" }}
        onChange={onChange}
      />
    );

    const textarea = screen.getByLabelText("Environment variables");
    fireEvent.change(textarea, {
      target: { value: "FIRST=updated\nTHIRD=three" },
    });

    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledWith({
      FIRST: "updated",
      THIRD: "three",
    });
  });

  it("ignores malformed lines and preserves equals signs in values", () => {
    const onChange = vi.fn();
    render(
      <KeyValueMapEditor label="Headers" value={{}} onChange={onChange} />
    );

    const textarea = screen.getByLabelText("Headers");
    fireEvent.change(textarea, {
      target: {
        value:
          "Authorization=Bearer token=with=equals\nmalformed\n=missing-key",
      },
    });
    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledWith({
      Authorization: "Bearer token=with=equals",
    });
  });

  it("inserts a secret reference when the opt-in picker is enabled", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "API_TOKEN",
        scope: "workspace",
        state: "managed-and-set",
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    const onChange = vi.fn();
    render(
      <KeyValueMapEditor
        label="Headers"
        value={{}}
        onChange={onChange}
        allowSecretReferences
      />
    );

    fireEvent.change(screen.getByLabelText("Insert secret reference"), {
      target: { value: "API_TOKEN" },
    });

    expect(onChange).toHaveBeenCalledWith({
      API_TOKEN: "${secret:API_TOKEN}",
    });
  });

  it("uses the standard dropdown text size and height", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "API_TOKEN",
        scope: "workspace",
        state: "managed-and-set",
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);

    render(
      <KeyValueMapEditor
        label="Headers"
        value={{}}
        onChange={vi.fn()}
        allowSecretReferences
      />
    );

    const picker = screen.getByLabelText("Insert secret reference");
    expect(picker).toHaveClass("text-xs");
    expect(picker).toHaveClass("h-7");
  });

  it("only shows the credential warning when secret references are enabled", () => {
    const props = {
      label: "Workflow variables",
      value: { API_TOKEN: "ghp_12345678901234567890" },
      onChange: vi.fn(),
    };
    const { rerender } = render(<KeyValueMapEditor {...props} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(<KeyValueMapEditor {...props} allowSecretReferences />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "looks like a pasted credential"
    );
  });

  it("disables editing and the optional picker", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "API_TOKEN",
        scope: "workspace",
        state: "managed-and-set",
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    render(
      <KeyValueMapEditor
        label="Headers"
        value={{}}
        onChange={vi.fn()}
        allowSecretReferences
        disabled
      />
    );

    expect(screen.getByLabelText("Headers")).toBeDisabled();
    expect(screen.getByLabelText("Insert secret reference")).toBeDisabled();
  });
});
