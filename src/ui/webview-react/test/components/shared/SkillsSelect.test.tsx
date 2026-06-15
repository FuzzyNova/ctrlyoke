import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillsSelect } from "@components/shared/SkillsSelect";

const SKILLS = [
  { name: "lint", description: "Run linting" },
  { name: "test", description: "Run tests" },
];

describe("SkillsSelect", () => {
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
    await user.click(screen.getAllByTitle("Hide this option")[0]);

    expect(onHideOption).toHaveBeenCalledWith("lint");
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
    await user.click(screen.getByText(/Show hidden/i));
    await user.click(screen.getByTitle("Unhide this option"));

    expect(onUnhideOption).toHaveBeenCalledWith("test");
  });
});
