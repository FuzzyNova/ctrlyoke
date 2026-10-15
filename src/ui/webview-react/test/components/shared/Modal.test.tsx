import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Modal } from "@components/shared/Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal isOpen={false} onClose={vi.fn()} title="Test">
        body
      </Modal>
    );
    expect(screen.queryByText("Test")).not.toBeInTheDocument();
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("renders title and children when open", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="My Modal">
        <p>Modal body</p>
      </Modal>
    );
    expect(screen.getByText("My Modal")).toBeInTheDocument();
    expect(screen.getByText("Modal body")).toBeInTheDocument();
  });

  it("renders optional footer", () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="T" footer={<button>OK</button>}>
        body
      </Modal>
    );
    expect(screen.getByRole("button", { name: "OK" })).toBeInTheDocument();
  });

  it("calls onClose when close button clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="T">
        body
      </Modal>
    );
    await user.click(screen.getByRole("button", { name: "Close modal" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking the backdrop", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <Modal isOpen onClose={onClose} title="T">
        body
      </Modal>
    );
    const backdrop = container.ownerDocument.querySelector(
      ".fixed.inset-0"
    ) as HTMLElement;
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking the modal content area", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="T">
        <span>inner</span>
      </Modal>
    );
    await user.click(screen.getByText("inner"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="T">
        body
      </Modal>
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when Escape is already prevented", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="T">
        body
      </Modal>
    );
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();

    document.dispatchEvent(event);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the topmost nested modal on Escape", () => {
    const onParentClose = vi.fn();
    const NestedModals = () => {
      const [innerOpen, setInnerOpen] = useState(true);
      return (
        <Modal isOpen onClose={onParentClose} title="Parent">
          <Modal
            isOpen={innerOpen}
            onClose={() => setInnerOpen(false)}
            title="Nested"
          >
            body
          </Modal>
        </Modal>
      );
    };
    render(<NestedModals />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Nested" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Parent" })).toBeInTheDocument();
    expect(onParentClose).not.toHaveBeenCalled();
  });

  it("lets an open CodeMirror completion popup handle Escape first", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Editor">
        <div
          role="textbox"
          aria-label="Editor"
          className="cm-editor"
          tabIndex={0}
        >
          <div className="cm-tooltip-autocomplete">Suggestions</div>
        </div>
      </Modal>
    );
    screen.getByRole("textbox", { name: "Editor" }).focus();

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not call onClose on Escape when closed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal isOpen={false} onClose={onClose} title="T">
        body
      </Modal>
    );
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders the full size as a viewport-filling flex dialog", () => {
    render(
      <Modal
        isOpen
        title="Full dialog"
        onClose={() => undefined}
        size="full"
        footer={<button type="button">Confirm</button>}
      >
        <p>Scrollable body</p>
      </Modal>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass(
      "max-w-none",
      "w-full",
      "h-full",
      "rounded-none",
      "border-0",
      "flex",
      "flex-col"
    );
    expect(dialog.parentElement).toHaveClass(
      "fixed",
      "inset-0",
      "flex",
      "flex-col"
    );
    expect(screen.getByText("Scrollable body").parentElement).toHaveClass(
      "flex-1",
      "min-h-0",
      "overflow-y-auto"
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("truncates the title by default and wraps it when asked", () => {
    const { rerender } = render(
      <Modal isOpen onClose={vi.fn()} title="A long approval title">
        body
      </Modal>
    );
    const heading = screen.getByRole("heading", {
      name: "A long approval title",
    });
    expect(heading).toHaveClass("truncate");

    rerender(
      <Modal isOpen onClose={vi.fn()} title="A long approval title" wrapTitle>
        body
      </Modal>
    );
    expect(heading).not.toHaveClass("truncate");
    expect(heading).toHaveClass("wrap-break-word");
  });
});
