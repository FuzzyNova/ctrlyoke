import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HighlightedText } from "@components/shared/HighlightedText";

describe("HighlightedText", () => {
  it("marks only matched runs", () => {
    const { container } = render(
      <HighlightedText text="Search settings" tokens={["settings"]} />
    );
    expect(
      screen.getByText("settings", { selector: "mark" })
    ).toBeInTheDocument();
    expect(container).toHaveTextContent("Search settings");
  });

  it("merges overlapping and adjacent matches", () => {
    const { container } = render(
      <HighlightedText text="abcdefgh" tokens={["abc", "cde", "fgh"]} />
    );
    expect(container.querySelectorAll("mark")).toHaveLength(1);
    expect(container.querySelector("mark")).toHaveTextContent("abcdefgh");
  });
});
