// Label colours and readable text on them (WCAG 2 relative luminance and
// contrast ratio). Used for sticky notes, label chips and the Settings preview.

/** Text colours a label colour can carry: near-black or white. */
export const DARK_TEXT = "#111111";
export const LIGHT_TEXT = "#ffffff";
export type TextColour = typeof DARK_TEXT | typeof LIGHT_TEXT;

/** WCAG AA contrast for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;

export interface PresetColour {
  name: string;
  /** Lower-case #rrggbb */
  hex: string;
}

/**
 * The palette offered when creating or recolouring a label. Soft tones read
 * well as sticky-note fills on a light or a dark canvas; the four deep tones
 * give strong contrast for labels that must stand out. Every preset has a
 * contrast of at least 4.5 with the text colour textColourFor() picks.
 */
export const PRESET_COLOURS: readonly PresetColour[] = [
  { name: "Butter", hex: "#fde68a" },
  { name: "Apricot", hex: "#fdba74" },
  { name: "Coral", hex: "#fca5a5" },
  { name: "Blossom", hex: "#f9a8d4" },
  { name: "Lavender", hex: "#c4b5fd" },
  { name: "Sky", hex: "#93c5fd" },
  { name: "Mint", hex: "#86efac" },
  { name: "Seafoam", hex: "#5eead4" },
  { name: "Stone", hex: "#d6d3d1" },
  { name: "Navy", hex: "#1e3a8a" },
  { name: "Forest", hex: "#166534" },
  { name: "Plum", hex: "#6b21a8" },
];

const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;

/**
 * "#ABC", "abc", "#AaBbCc" or " aabbcc " → "#aabbcc". Returns null for
 * anything that is not a three- or six-digit hex colour.
 */
export function normaliseHex(input: string): string | null {
  const value = input.trim();
  const six = HEX6.exec(value);
  if (six?.[1]) return `#${six[1].toLowerCase()}`;
  const three = HEX3.exec(value);
  if (three?.[1]) {
    const [r = "", g = "", b = ""] = three[1].toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

function channels(hex: string): [number, number, number] {
  const normal = normaliseHex(hex);
  if (normal === null) throw new Error("Not a hex colour");
  return [1, 3, 5].map((i) => parseInt(normal.slice(i, i + 2), 16)) as [number, number, number];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The text colour with the higher contrast on the given background. An
 * unreadable value falls back to dark text.
 */
export function textColourFor(background: string): TextColour {
  if (normaliseHex(background) === null) return DARK_TEXT;
  return contrastRatio(background, DARK_TEXT) >= contrastRatio(background, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}
