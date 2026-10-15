// SPEC 8: text on a label colour is chosen for contrast; tested with light
// and dark labels.

import { describe, expect, it } from "vitest";
import {
  DARK_TEXT,
  LIGHT_TEXT,
  MIN_TEXT_CONTRAST,
  PRESET_COLOURS,
  contrastRatio,
  normaliseHex,
  relativeLuminance,
  textColourFor,
} from "../../src/shared/colour";

describe("normaliseHex", () => {
  it("accepts six- and three-digit colours in any case, with or without #", () => {
    expect(normaliseHex("#FFF59D")).toBe("#fff59d");
    expect(normaliseHex("1e3a8a")).toBe("#1e3a8a");
    expect(normaliseHex(" #AbC ")).toBe("#aabbcc");
    expect(normaliseHex("f0a")).toBe("#ff00aa");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "#", "#12345", "#1234567", "red", "#ggg000", "rgb(0,0,0)"]) {
      expect(normaliseHex(bad), bad).toBeNull();
    }
  });
});

describe("contrast", () => {
  it("matches the WCAG reference values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // #767676 on white is the classic just-passing AA grey (4.54:1).
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });
});

describe("textColourFor", () => {
  it("puts dark text on light labels", () => {
    expect(textColourFor("#fff59d")).toBe(DARK_TEXT);
    expect(textColourFor("#ffffff")).toBe(DARK_TEXT);
    expect(textColourFor("#86efac")).toBe(DARK_TEXT);
    expect(textColourFor("#FDE68A")).toBe(DARK_TEXT);
  });

  it("puts white text on dark labels", () => {
    expect(textColourFor("#1e3a8a")).toBe(LIGHT_TEXT);
    expect(textColourFor("#000000")).toBe(LIGHT_TEXT);
    expect(textColourFor("#6b21a8")).toBe(LIGHT_TEXT);
    expect(textColourFor("#b91c1c")).toBe(LIGHT_TEXT);
  });

  it("picks whichever text colour has the higher contrast", () => {
    for (const hex of ["#808080", "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#5a5a5a", "#a0a0a0"]) {
      const chosen = textColourFor(hex);
      const other = chosen === DARK_TEXT ? LIGHT_TEXT : DARK_TEXT;
      expect(contrastRatio(hex, chosen), hex).toBeGreaterThanOrEqual(contrastRatio(hex, other));
    }
  });

  it("falls back to dark text for a value that is not a colour", () => {
    expect(textColourFor("not a colour")).toBe(DARK_TEXT);
  });
});

describe("PRESET_COLOURS", () => {
  it("offers about ten named, distinct, normalised colours", () => {
    expect(PRESET_COLOURS.length).toBeGreaterThanOrEqual(8);
    expect(PRESET_COLOURS.length).toBeLessThanOrEqual(14);
    expect(new Set(PRESET_COLOURS.map((p) => p.hex)).size).toBe(PRESET_COLOURS.length);
    expect(new Set(PRESET_COLOURS.map((p) => p.name)).size).toBe(PRESET_COLOURS.length);
    for (const preset of PRESET_COLOURS) {
      expect(normaliseHex(preset.hex)).toBe(preset.hex);
      expect(preset.name.trim()).not.toBe("");
    }
  });

  it("gives every preset readable text (contrast of at least 4.5)", () => {
    for (const preset of PRESET_COLOURS) {
      const ratio = contrastRatio(preset.hex, textColourFor(preset.hex));
      expect(ratio, `${preset.name} ${preset.hex}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("includes both light labels (dark text) and dark labels (white text)", () => {
    const texts = new Set(PRESET_COLOURS.map((p) => textColourFor(p.hex)));
    expect(texts).toEqual(new Set([DARK_TEXT, LIGHT_TEXT]));
  });
});
