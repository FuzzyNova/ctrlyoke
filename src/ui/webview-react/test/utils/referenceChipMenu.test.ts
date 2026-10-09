import { describe, expect, it, vi } from "vitest";
import { findAtomicReferences } from "@utils/atomicReferences";
import {
  buildReferenceChipMenuItems,
  REFERENCE_CHIP_MENU_LABELS,
  wrapInInlineCode,
} from "@utils/referenceChipMenu";

describe("wrapInInlineCode", () => {
  it.each([
    ["@src/a.ts", "`@src/a.ts`"],
    ["/skill:commit", "`/skill:commit`"],
    ["a`b", "``a`b``"],
    ["`a", "`` `a ``"],
  ])("wraps %s so it is literal", (text, expected) => {
    expect(wrapInInlineCode(text)).toBe(expected);
  });

  it.each(["@src/a.ts", "#selection:src/a.ts:1-2", "$previous", "/mcp:play"])(
    "stops %s from parsing as a reference",
    (reference) => {
      expect(findAtomicReferences(reference)).toHaveLength(1);
      expect(
        findAtomicReferences(`see ${wrapInInlineCode(reference)} here`)
      ).toEqual([]);
    }
  );
});

describe("buildReferenceChipMenuItems", () => {
  const labels = (items: ReturnType<typeof buildReferenceChipMenuItems>) =>
    items.map((entry) => ("label" in entry ? entry.label : entry.type));

  it("omits Send as Plain Text where the reference isn't editable", () => {
    expect(
      labels(buildReferenceChipMenuItems({ open: vi.fn(), sourceText: "@a" }))
    ).toEqual([
      REFERENCE_CHIP_MENU_LABELS.GO_TO,
      REFERENCE_CHIP_MENU_LABELS.COPY,
    ]);
  });

  it("disables Go to for an unresolvable reference", () => {
    const [goTo] = buildReferenceChipMenuItems({
      open: vi.fn(),
      sourceText: "@missing.ts",
      invalid: true,
    });
    expect(goTo).toMatchObject({
      label: REFERENCE_CHIP_MENU_LABELS.GO_TO,
      disabled: true,
    });
  });
});
