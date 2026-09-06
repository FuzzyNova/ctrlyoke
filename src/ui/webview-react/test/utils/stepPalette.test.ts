import { describe, expect, it } from "vitest";

import {
  HARNESS_CHART_COLORS,
  SCRIPT_STEP_DEFAULT_COLOR,
  STEP_COLOR_PALETTES,
} from "@root/types/DashboardConstants";

const PALETTE_SIZE = 24;
// CIEDE2000 ~2.3 is a just-noticeable difference; 8 leaves useful separation
// after theme rendering and the 2px identity bars have been antialiased.
const MIN_DISTANCE = 8;
// The first tier is the common case and is read as a positional ramp, so its
// adjacent hues get a stronger CIEDE2000 separation than cross-tier steps.
const MIN_TIER_ZERO_ADJACENT_DISTANCE = 18;

const INDICATOR_ACCENT_FALLBACKS = ["#89d185", "#c24038", "#d19a66"];

type Rgb = [number, number, number];
type Lab = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const match = /^#([\da-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected a six-digit hex color: ${hex}`);
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
}

function srgbToLab(hex: string): Lab {
  const [red, green, blue] = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047;
  const y = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 1;
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883;
  const labPivot = (value: number) =>
    value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = labPivot(x);
  const fy = labPivot(y);
  const fz = labPivot(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function ciede2000(firstHex: string, secondHex: string): number {
  const [lightnessOne, aOne, bOne] = srgbToLab(firstHex);
  const [lightnessTwo, aTwo, bTwo] = srgbToLab(secondHex);
  const chromaOne = Math.hypot(aOne, bOne);
  const chromaTwo = Math.hypot(aTwo, bTwo);
  const meanChroma = (chromaOne + chromaTwo) / 2;
  const compensation =
    0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const adjustedAOne = (1 + compensation) * aOne;
  const adjustedATwo = (1 + compensation) * aTwo;
  const adjustedChromaOne = Math.hypot(adjustedAOne, bOne);
  const adjustedChromaTwo = Math.hypot(adjustedATwo, bTwo);
  const hue = (a: number, b: number) => {
    const degrees = (Math.atan2(b, a) * 180) / Math.PI;
    return degrees < 0 ? degrees + 360 : degrees;
  };
  const hueOne = hue(adjustedAOne, bOne);
  const hueTwo = hue(adjustedATwo, bTwo);
  const deltaLightness = lightnessTwo - lightnessOne;
  const deltaChroma = adjustedChromaTwo - adjustedChromaOne;
  const hueDifference =
    Math.abs(hueTwo - hueOne) <= 180
      ? hueTwo - hueOne
      : hueTwo <= hueOne
        ? hueTwo - hueOne + 360
        : hueTwo - hueOne - 360;
  const deltaHue =
    2 *
    Math.sqrt(adjustedChromaOne * adjustedChromaTwo) *
    Math.sin((hueDifference / 2 / 180) * Math.PI);
  const meanLightness = (lightnessOne + lightnessTwo) / 2;
  const meanAdjustedChroma = (adjustedChromaOne + adjustedChromaTwo) / 2;
  const meanHue =
    Math.abs(hueOne - hueTwo) <= 180
      ? (hueOne + hueTwo) / 2
      : hueOne + hueTwo < 360
        ? (hueOne + hueTwo + 360) / 2
        : (hueOne + hueTwo - 360) / 2;
  const lightnessWeight =
    1 -
    (0.015 * (meanLightness - 50) ** 2) /
      Math.sqrt(20 + (meanLightness - 50) ** 2);
  const chromaWeight = 1 + 0.045 * meanAdjustedChroma;
  const hueWeight =
    1 +
    0.015 *
      Math.cos(
        ((30 * Math.exp(-(((meanHue - 275) / 25) ** 2)) - 10) / 180) * Math.PI
      );
  const hueRotation = 30 * Math.exp(-(((meanHue - 275) / 25) ** 2));
  const chromaCompensation =
    2 *
    Math.sqrt(meanAdjustedChroma ** 7 / (meanAdjustedChroma ** 7 + 25 ** 7));
  const lightnessTerm = deltaLightness / lightnessWeight;
  const chromaTerm = deltaChroma / chromaWeight;
  const hueTerm = deltaHue / hueWeight;
  const rotationTerm =
    -Math.sin((2 * hueRotation * Math.PI) / 180) *
    (chromaCompensation * (deltaChroma / chromaWeight)) *
    (deltaHue / hueWeight);

  return Math.sqrt(
    lightnessTerm ** 2 + chromaTerm ** 2 + hueTerm ** 2 + rotationTerm
  );
}

function hexFallbacks(): string[] {
  return [
    ...Object.values(HARNESS_CHART_COLORS).map(
      (color) => /#[\da-f]{6}/i.exec(color)?.[0] ?? ""
    ),
    /#[\da-f]{6}/i.exec(SCRIPT_STEP_DEFAULT_COLOR)?.[0] ?? "",
    ...INDICATOR_ACCENT_FALLBACKS,
  ];
}

function assertPaletteProperties(
  name: "light" | "dark",
  colors: readonly string[]
) {
  expect(colors).toHaveLength(PALETTE_SIZE);
  expect(new Set(colors).size).toBe(PALETTE_SIZE);
  expect(colors.every((color) => /^#[\da-f]{6}$/i.test(color))).toBe(true);
  expect(
    colors.every((color) =>
      hexToRgb(color).every((channel) => channel >= 0 && channel <= 255)
    )
  ).toBe(true);

  for (const color of colors) {
    for (const fallback of hexFallbacks()) {
      expect(
        ciede2000(color, fallback),
        `${name} ${color} vs ${fallback}`
      ).toBeGreaterThanOrEqual(MIN_DISTANCE);
    }
  }

  for (let index = 0; index < colors.length - 1; index += 1) {
    const distance = ciede2000(colors[index], colors[index + 1]);
    const threshold =
      index < 7 ? MIN_TIER_ZERO_ADJACENT_DISTANCE : MIN_DISTANCE;
    expect(
      distance,
      `${name} adjacent ${index}/${index + 1}`
    ).toBeGreaterThanOrEqual(threshold);
  }
}

describe("generated step palette", () => {
  it("satisfies the perceptual separation and gamut properties", () => {
    assertPaletteProperties("light", STEP_COLOR_PALETTES.rainbow.light);
    assertPaletteProperties("dark", STEP_COLOR_PALETTES.rainbow.dark);
  });

  it("keeps both generated tables stable", () => {
    expect(STEP_COLOR_PALETTES.rainbow).toMatchInlineSnapshot(`
      {
        "dark": [
          "#ff8fb4",
          "#ff996a",
          "#dfb100",
          "#82d04f",
          "#00d4bb",
          "#00cafe",
          "#9cb4ff",
          "#df94ff",
          "#ffc7ca",
          "#ffcca3",
          "#eadd24",
          "#72f896",
          "#00f6f6",
          "#b1deff",
          "#d3d3ff",
          "#ffbff8",
          "#ffdbd5",
          "#ffdfb4",
          "#d6f55b",
          "#8effd0",
          "#acf2ff",
          "#d4e6ff",
          "#e9deff",
          "#ffd8ec",
        ],
        "light": [
          "#c93f76",
          "#c65100",
          "#967600",
          "#498f00",
          "#008e7d",
          "#0087ab",
          "#526ee3",
          "#a151c2",
          "#c0304c",
          "#a25900",
          "#797200",
          "#00853c",
          "#007f7f",
          "#0076af",
          "#6857d1",
          "#a53d9f",
          "#ac1c0f",
          "#7e5400",
          "#566600",
          "#006f4f",
          "#006a77",
          "#005bb4",
          "#6f3bb2",
          "#9d1f74",
        ],
      }
    `);
  });
});
