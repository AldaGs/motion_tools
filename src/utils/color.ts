// Color math for the harmony explorer. Everything runs on HSL because the
// harmonies are defined as rotations around the hue wheel; hex is only the
// I/O format.

export interface HSL { h: number; s: number; l: number } // h:0-360, s/l:0-100

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Wrap a hue into [0,360).
export const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

export const hexToHsl = (hex: string): HSL | null => {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgbToHsl(rgb.r, rgb.g, rgb.b);
};

export const hslToHex = (hsl: HSL): string => {
  const { r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l);
  return rgbToHex(r, g, b);
};

export const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
};

export const rgbToHex = (r: number, g: number, b: number): string => {
  const to = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
};

export const rgbToHsl = (r: number, g: number, b: number): HSL => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h: wrapHue(h), s: clamp(s * 100, 0, 100), l: clamp(l * 100, 0, 100) };
};

export const hslToRgb = (h: number, s: number, l: number): { r: number; g: number; b: number } => {
  h = wrapHue(h); s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
};

export type HarmonyKey =
  | 'complementary'
  | 'analogous'
  | 'splitComplementary'
  | 'triad'
  | 'square'
  | 'compound'
  | 'monochromatic'
  | 'shades';

export interface Harmony {
  key: HarmonyKey;
  label: string;
  colors: HSL[]; // first entry is always the base color
}

// Hue offsets (degrees) applied to the base for the rotational harmonies.
const HUE_OFFSETS: Partial<Record<HarmonyKey, number[]>> = {
  complementary: [0, 180],
  analogous: [-30, 0, 30],
  splitComplementary: [0, 150, 210],
  triad: [0, 120, 240],
  square: [0, 90, 180, 270],
  // Compound: base + its two split-complements, plus one analogous neighbour —
  // a warm/cool pairing that stays cohesive.
  compound: [0, 30, 180, 210],
};

const LABELS: Record<HarmonyKey, string> = {
  complementary: 'Complementary',
  analogous: 'Analogous',
  splitComplementary: 'Split Complementary',
  triad: 'Triad',
  square: 'Square',
  compound: 'Compound',
  monochromatic: 'Monochromatic',
  shades: 'Shades',
};

export const buildHarmony = (base: HSL, key: HarmonyKey): Harmony => {
  let colors: HSL[];
  if (key === 'monochromatic') {
    // Same hue, fan the lightness out around the base while nudging saturation
    // so the steps read as distinct swatches rather than a flat wash.
    const steps = [-30, -15, 0, 15, 30];
    colors = steps.map((dl) => ({
      h: base.h,
      s: clamp(base.s, 0, 100),
      l: clamp(base.l + dl, 8, 96),
    }));
  } else if (key === 'shades') {
    // Same hue/sat, walk lightness down toward black.
    const ls = [72, 58, 44, 30, 16];
    colors = ls.map((l) => ({ h: base.h, s: base.s, l }));
  } else {
    const offsets = HUE_OFFSETS[key]!;
    colors = offsets.map((o) => ({ h: wrapHue(base.h + o), s: base.s, l: base.l }));
  }
  return { key, label: LABELS[key], colors };
};

export const ALL_HARMONIES: HarmonyKey[] = [
  'complementary',
  'analogous',
  'splitComplementary',
  'triad',
  'square',
  'compound',
  'monochromatic',
  'shades',
];

export const buildAllHarmonies = (base: HSL): Harmony[] =>
  ALL_HARMONIES.map((k) => buildHarmony(base, k));
