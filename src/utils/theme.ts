// src/utils/theme.ts
// Reads After Effects' panel theme (Preferences → Appearance → Brightness)
// via CSInterface and writes matching CSS variables onto :root so the panel
// blends with the host app instead of always being a hardcoded dark.

type RGB = { red: number; green: number; blue: number };
type AppSkinInfo = {
  panelBackgroundColor?: { color: RGB };
  appBarBackgroundColor?: { color: RGB };
  systemHighlightColor?: RGB;
};

const toRgb = (c: RGB) => `rgb(${Math.round(c.red)}, ${Math.round(c.green)}, ${Math.round(c.blue)})`;

const luminance = ({ red, green, blue }: RGB) =>
  (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

const shift = ({ red, green, blue }: RGB, delta: number): RGB => ({
  red:   Math.max(0, Math.min(255, red + delta)),
  green: Math.max(0, Math.min(255, green + delta)),
  blue:  Math.max(0, Math.min(255, blue + delta)),
});

export function applyAEHostTheme() {
  if (typeof window.CSInterface === 'undefined') return;
  try {
    const cs = new window.CSInterface();
    const env = cs.getHostEnvironment?.();
    const skin: AppSkinInfo | undefined = env?.appSkinInfo;
    if (!skin?.panelBackgroundColor?.color) return;

    const bg = skin.panelBackgroundColor.color;
    const isDark = luminance(bg) < 0.5;

    const fg       = isDark ? { red: 214, green: 214, blue: 214 } : { red: 30, green: 30, blue: 30 };
    const fgMuted  = isDark ? { red: 138, green: 138, blue: 138 } : { red: 102, green: 102, blue: 102 };
    const fgDim    = isDark ? { red: 102, green: 102, blue: 102 } : { red: 138, green: 138, blue: 138 };
    const elev     = shift(bg, isDark ? +12 : -12);
    const sunken   = shift(bg, isDark ? -12 : +12);
    const border   = shift(bg, isDark ? +24 : -24);
    const borderStrong = shift(bg, isDark ? +44 : -44);

    const root = document.documentElement.style;
    root.setProperty('--panel-bg',         toRgb(bg));
    root.setProperty('--panel-bg-elev',    toRgb(elev));
    root.setProperty('--panel-bg-sunken',  toRgb(sunken));
    root.setProperty('--panel-fg',         toRgb(fg));
    root.setProperty('--panel-fg-muted',   toRgb(fgMuted));
    root.setProperty('--panel-fg-dim',     toRgb(fgDim));
    root.setProperty('--panel-border',     toRgb(border));
    root.setProperty('--panel-border-strong', toRgb(borderStrong));

    if (skin.systemHighlightColor) {
      root.setProperty('--accent', toRgb(skin.systemHighlightColor));
    }
  } catch (err) {
    console.warn('Failed to apply AE host theme', err);
  }
}
