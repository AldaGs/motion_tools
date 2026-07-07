// Reads the Adobe host's UI theme via CEP's appSkinInfo so the panel matches
// whatever brightness/accent the user has set in AE/AI/PS. Falls back to an
// Adobe-dark palette outside a CEP host (browser dev).

export interface HostTheme {
  bg: string;          // panel background (matches the host)
  bgElevated: string;  // inputs / raised boxes
  bgInset: string;     // log wells / recessed areas
  text: string;
  textDim: string;
  border: string;
  accent: string;      // selected / active (host highlight color)
  accentText: string;
  hover: string;
  fontFamily: string;
  fontSize: number;
  isDark: boolean;
}

const FALLBACK: HostTheme = {
  bg: '#323232',
  bgElevated: '#393939',
  bgInset: '#262626',
  text: '#e8e8e8',
  textDim: '#9a9a9a',
  border: '#232323',
  accent: '#2680eb',
  accentText: '#ffffff',
  hover: '#404040',
  fontFamily: '"Adobe Clean", "Source Sans Pro", system-ui, sans-serif',
  fontSize: 11,
  isDark: true,
};

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const toCss = (r: number, g: number, b: number) => `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;

// Shift a color toward white (amt>0) or black (amt<0) by a 0..1 fraction.
const shade = (r: number, g: number, b: number, amt: number): string => {
  const t = amt >= 0 ? 255 : 0;
  const f = Math.abs(amt);
  return toCss(r + (t - r) * f, g + (t - g) * f, b + (t - b) * f);
};

export function getHostTheme(): HostTheme {
  try {
    const w = window as unknown as { CSInterface?: new () => { getHostEnvironment: () => { appSkinInfo?: Record<string, unknown> } } };
    if (typeof w.CSInterface === 'undefined') return FALLBACK;
    const cs = new w.CSInterface();
    const skin = cs.getHostEnvironment()?.appSkinInfo as Record<string, unknown> | undefined;
    if (!skin) return FALLBACK;

    const pc = (skin.panelBackgroundColor as { color?: { red: number; green: number; blue: number } } | undefined)?.color;
    if (!pc) return FALLBACK;
    const r = pc.red, g = pc.green, b = pc.blue;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const isDark = lum < 0.5;

    // Accent: prefer the host's highlight color when it exposes one.
    let accent = FALLBACK.accent;
    const hc = skin.systemHighlightColor as { red: number; green: number; blue: number } | undefined;
    if (hc && typeof hc.red === 'number') accent = toCss(hc.red, hc.green, hc.blue);

    const rawFont = typeof skin.baseFontFamily === 'string' ? (skin.baseFontFamily as string) : '';
    const rawSize = Number(skin.baseFontSize);

    return {
      bg: toCss(r, g, b),
      bgElevated: shade(r, g, b, isDark ? 0.07 : -0.04),
      bgInset: shade(r, g, b, isDark ? -0.10 : -0.06),
      text: isDark ? '#e8e8e8' : '#1c1c1c',
      textDim: isDark ? '#9a9a9a' : '#5c5c5c',
      border: shade(r, g, b, isDark ? -0.14 : -0.16),
      accent,
      accentText: '#ffffff',
      hover: shade(r, g, b, isDark ? 0.13 : -0.09),
      fontFamily: rawFont
        ? `"${rawFont}", "Adobe Clean", system-ui, sans-serif`
        : FALLBACK.fontFamily,
      fontSize: rawSize > 0 ? Math.max(10, Math.min(14, Math.round(rawSize))) : FALLBACK.fontSize,
      isDark,
    };
  } catch {
    return FALLBACK;
  }
}
