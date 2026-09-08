import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY_VALUE_KEY_KINDS } from "@root/utils/KeyValueKeyKinds";
import { KeyValueRowsEditor } from "@components/shared/KeyValueRowsEditor";
import { useSecretRegistryStore } from "@store/secretRegistryStore";

const secretEntry = {
  name: "TOKEN",
  scope: "workspace" as const,
  state: "managed-and-set" as const,
  usedBy: { mcpServers: [], workflows: [] },
};

function renderEditor(
  value: Record<string, string>,
  onChange = vi.fn(),
  props: Partial<React.ComponentProps<typeof KeyValueRowsEditor>> = {}
) {
  return render(
    <KeyValueRowsEditor
      label="Environment variables"
      value={value}
      onChange={onChange}
      keyKind={KEY_VALUE_KEY_KINDS.ENV}
      {...props}
    />
  );
}

afterEach(() => {
  cleanup();
  useSecretRegistryStore.getState().resetSecretRegistry();
});

describe("KeyValueRowsEditor", () => {
  it("commits key and value edits on blur, not on keystroke", () => {
    const onChange = vi.fn();
    renderEditor({ FIRST: "one" }, onChange);

    const keyInput = screen.getByLabelText("Name for FIRST");
    fireEvent.change(keyInput, { target: { value: "UPDATED" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(keyInput);
    expect(onChange).toHaveBeenLastCalledWith({ UPDATED: "one" });

    const valueInput = screen.getByLabelText("Value for UPDATED");
    fireEvent.change(valueInput, { target: { value: "changed" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.blur(valueInput);
    expect(onChange).toHaveBeenLastCalledWith({ UPDATED: "changed" });
  });

  it("preserves row order and focus when renaming a key", () => {
    renderEditor({ FIRST: "one", SECOND: "two" });

    const firstInput = screen.getByLabelText("Name for FIRST");
    firstInput.focus();
    fireEvent.change(firstInput, { target: { value: "RENAMED" } });

    expect(document.activeElement).toBe(firstInput);
    expect(screen.getAllByRole("textbox")[0]).toHaveValue("RENAMED");
    expect(screen.getAllByRole("textbox")[1]).toHaveValue("one");
    expect(screen.getAllByRole("textbox")[2]).toHaveValue("SECOND");
  });

  it("does not replace live edits with the parent's echo of a commit", () => {
    const onChange = vi.fn();
    const { rerender } = renderEditor({ FIRST: "one" }, onChange);

    const keyInput = screen.getByLabelText("Name for FIRST");
    fireEvent.change(keyInput, { target: { value: "UPDATED" } });
    fireEvent.blur(keyInput);

    const valueInput = screen.getByLabelText("Value for UPDATED");
    fireEvent.change(valueInput, { target: { value: "still editing" } });
    rerender(
      <KeyValueRowsEditor
        label="Environment variables"
        value={{ UPDATED: "one" }}
        onChange={onChange}
        keyKind={KEY_VALUE_KEY_KINDS.ENV}
      />
    );

    expect(screen.getByLabelText("Value for UPDATED")).toHaveValue(
      "still editing"
    );
  });

  it("flags both duplicate rows and commits the last value", () => {
    const onChange = vi.fn();
    renderEditor({ FIRST: "one", SECOND: "two" }, onChange);

    fireEvent.change(screen.getByLabelText("Name for SECOND"), {
      target: { value: "FIRST" },
    });

    expect(screen.getAllByText("This key is duplicated exactly.")).toHaveLength(
      2
    );
    fireEvent.blur(screen.getAllByLabelText("Name for FIRST")[1]);
    expect(onChange).toHaveBeenLastCalledWith({ FIRST: "two" });
  });

  it("keeps an empty-key row visible while excluding it from commits", () => {
    const onChange = vi.fn();
    renderEditor({}, onChange);

    fireEvent.click(screen.getByRole("button", { name: "+ Add entry" }));
    expect(screen.getByRole("textbox", { name: "entry name" })).toBeVisible();
    expect(onChange).toHaveBeenLastCalledWith({});

    const valueInput = screen.getByRole("textbox", { name: "entry value" });
    fireEvent.change(valueInput, { target: { value: "orphaned" } });
    fireEvent.blur(valueInput);
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(
      screen.getByText("This row will not be saved because its key is empty.")
    ).toBeInTheDocument();
  });

  it("surfaces the variable-name error for my-var", () => {
    renderEditor({ "my-var": "value" }, vi.fn(), {
      keyKind: KEY_VALUE_KEY_KINDS.VARIABLE,
    });
    expect(
      screen.getByText((text) => text.startsWith("Variable names must match"))
    ).toBeInTheDocument();
  });

  it("surfaces the env-name error for 1BAD", () => {
    renderEditor({ "1BAD": "value" });
    expect(
      screen.getByText((text) =>
        text.startsWith("Environment variable names must start with")
      )
    ).toBeInTheDocument();
  });

  it("surfaces the header-token error for bad header", () => {
    renderEditor({ "bad header": "value" }, vi.fn(), {
      keyKind: KEY_VALUE_KEY_KINDS.HEADER,
    });
    expect(
      screen.getByText("Header names must be RFC 7230 tokens.")
    ).toBeInTheDocument();
  });

  it("surfaces the env uppercase convention warning", () => {
    renderEditor({ lowercase: "value" });
    expect(
      screen.getByText(
        "Environment variable names are conventionally uppercase."
      )
    ).toBeInTheDocument();
  });

  it("surfaces variable case collisions", () => {
    renderEditor({ region: "one", REGION: "two" }, vi.fn(), {
      keyKind: KEY_VALUE_KEY_KINDS.VARIABLE,
    });
    expect(
      screen.getAllByText("Another variable name differs only by case.")
    ).toHaveLength(2);
  });

  it("surfaces case-insensitive duplicate header errors", () => {
    renderEditor({ Region: "one", REGION: "two" }, vi.fn(), {
      keyKind: KEY_VALUE_KEY_KINDS.HEADER,
    });
    expect(
      screen.getAllByText("HTTP header names must not differ only by case.")
    ).toHaveLength(2);
  });

  it("does not flag Bearer secret interpolation as a pasted credential", () => {
    renderEditor({ Authorization: "Bearer ${secret:TOKEN}" }, vi.fn(), {
      allowSecretReferences: true,
    });
    expect(
      screen.queryByText(/looks like a pasted credential/)
    ).not.toBeInTheDocument();
  });

  it("warns when a secret reference is absent from the registry", () => {
    renderEditor({ API_TOKEN: "${secret:MISSING}" }, vi.fn(), {
      allowSecretReferences: true,
    });
    expect(
      screen.getByText(
        'Secret "MISSING" is not configured in the secret registry.'
      )
    ).toBeInTheDocument();
  });

  it("only shows credential warnings when secret references are enabled", () => {
    const props = { value: { API_TOKEN: "ghp_12345678901234567890" } };
    const { rerender } = renderEditor(props.value);
    expect(
      screen.queryByText(/looks like a pasted credential/)
    ).not.toBeInTheDocument();

    rerender(
      <KeyValueRowsEditor
        label="Environment variables"
        value={props.value}
        onChange={vi.fn()}
        keyKind={KEY_VALUE_KEY_KINDS.ENV}
        allowSecretReferences
      />
    );
    expect(
      screen.getByText(/looks like a pasted credential/)
    ).toBeInTheDocument();
  });

  it("sets the selected secret on the active row without changing its key", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [secretEntry]);
    const onChange = vi.fn();
    renderEditor({ API_TOKEN: "old" }, onChange, {
      allowSecretReferences: true,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Insert secret reference for API_TOKEN",
      })
    );
    fireEvent.click(screen.getByRole("option", { name: "Use secret TOKEN" }));

    expect(screen.getByLabelText("Value for API_TOKEN")).toHaveValue(
      "${secret:TOKEN}"
    );
    expect(onChange).toHaveBeenLastCalledWith({
      API_TOKEN: "${secret:TOKEN}",
    });
  });

  it("disables all row controls and add/delete actions", () => {
    useSecretRegistryStore.getState().setEntries("workspace", [secretEntry]);
    renderEditor({ API_TOKEN: "value" }, vi.fn(), {
      allowSecretReferences: true,
      disabled: true,
    });

    expect(screen.getByLabelText("Name for API_TOKEN")).toBeDisabled();
    expect(screen.getByLabelText("Value for API_TOKEN")).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Insert secret reference for API_TOKEN",
      })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete API_TOKEN" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Add entry" })).toBeDisabled();
  });
});
