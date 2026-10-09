import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillsSelect } from "@components/shared/SkillsSelect";

const SKILLS = [
  { name: "lint", description: "Run linting" },
  { name: "test", description: "Run tests" },
];

describe("SkillsSelect", () => {
  it("renders a warning below the trigger and applies the warning border", () => {
    render(
      <SkillsSelect
        value={["missing"]}
        onChange={vi.fn()}
        availableSkills={SKILLS}
        warning={'1 skill not found: "missing".'}
      />
    );

    expect(screen.getByRole("button")).toHaveClass("border-warning-fg");
    expect(screen.getByText('1 skill not found: "missing".')).toHaveClass(
      "text-warning-fg"
    );
  });

  it("exposes the field name and controlled listbox state", async () => {
    const user = userEvent.setup();
    render(
      <SkillsSelect
        id="skills"
        value={undefined}
        onChange={vi.fn()}
        availableSkills={SKILLS}
      />
    );

    const trigger = screen.getByRole("button", { name: /^Skills/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls", "skills-listbox");

    await user.click(trigger);

    expect(screen.getByRole("listbox")).toHaveAttribute("id", "skills-listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the hidden toggle in inline mode when a namespace is provided", () => {
    const { container } = render(
      <SkillsSelect
        value={undefined}
        onChange={vi.fn()}
        availableSkills={SKILLS}
        namespace="skills"
        hiddenValues={["test"]}
        inline
      />
    );

    const wrapper = container.firstElementChild;
    expect(wrapper?.lastElementChild?.textContent).toContain("Show hidden");
  });

  it("calls onHideOption for visible skills", async () => {
    const user = userEvent.setup();
    const onHideOption = vi.fn();

    render(
      <SkillsSelect
        value={undefined}
        onChange={vi.fn()}
        availableSkills={SKILLS}
        namespace="skills"
        hiddenValues={[]}
        onHideOption={onHideOption}
      />
    );

    await user.click(screen.getByRole("button"));
    await user.click(
      screen.getAllByRole("button", { name: "Hide this option" })[0]
    );

    expect(onHideOption).toHaveBeenCalledWith("lint");
  });

  it("shows a visible skill's full description when hovering its row", async () => {
    const user = userEvent.setup();
    const description = "Run the full lint suite with project-specific rules.";

    render(
      <SkillsSelect
        value={undefined}
        onChange={vi.fn()}
        availableSkills={[{ name: "lint", description }]}
      />
    );

    await user.click(screen.getByRole("button"));

    expect(
      screen.getByTitle(new RegExp(`^lint\n\n${description}\n\n`), {
        normalizer: (title) => title,
      })
    ).toHaveTextContent("lint");
  });

  it("reveals hidden skills and lets the user unhide them", async () => {
    const user = userEvent.setup();
    const onUnhideOption = vi.fn();

    render(
      <SkillsSelect
        value={undefined}
        onChange={vi.fn()}
        availableSkills={SKILLS}
        namespace="skills"
        hiddenValues={["test"]}
        onUnhideOption={onUnhideOption}
      />
    );

    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button", { name: /Show hidden/i }));
    await user.click(
      screen.getByRole("button", { name: "Unhide this option" })
    );

    expect(onUnhideOption).toHaveBeenCalledWith("test");
  });

  it("shows a hidden skill's full description when hovering its row", async () => {
    const user = userEvent.setup();
    const description = "Run the full test suite with project-specific setup.";

    render(
      <SkillsSelect
        value={undefined}
        onChange={vi.fn()}
        availableSkills={[{ name: "test", description }]}
        namespace="skills"
        hiddenValues={["test"]}
      />
    );

    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button", { name: /Show hidden/i }));

    expect(
      screen.getByTitle(new RegExp(`^test\n\n${description}\n\n`), {
        normalizer: (title) => title,
      })
    ).toHaveTextContent("test");
  });
});
