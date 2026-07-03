import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildAllHarmonies,
  buildHarmony,
  hexToHsl,
  hslToHex,
  wrapHue,
  type HSL,
  type HarmonyKey,
  ALL_HARMONIES,
} from './utils/color';
import { toast } from './utils/toast';
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu';
import { loadColorState, saveColorState } from './utils/storage';

// Restore the previous session's config so a fresh panel open picks up where
// the user left off. Read once at module scope so useState can seed from it
// synchronously (no first-render flash of the default blue).
const SAVED = loadColorState();
const INITIAL_HSL: HSL = (SAVED && hexToHsl(SAVED.hex)) || { h: 210, s: 70, l: 50 };
const INITIAL_HARMONY: HarmonyKey =
  SAVED?.harmony && (ALL_HARMONIES as string[]).includes(SAVED.harmony)
    ? (SAVED.harmony as HarmonyKey)
    : 'complementary';

const HANDLE = 16;             // handle diameter
const WHEEL_MIN = 120;
const WHEEL_MAX = 320;
const WHEEL_DEFAULT = 200;

// CSS `conic-gradient` (no `from`) starts hue 0 at 12 o'clock and sweeps
// clockwise, so hue H sits at screen angle (H - 90)°. We apply that offset in
// both directions so the handle/dots land on the matching wheel color.
const ANGLE_OFFSET = -90;

// Map an HSL color to an (x,y) inside a wheel of radius R: hue = angle,
// saturation = radius.
const hslToXY = (h: number, s: number, R: number): { x: number; y: number } => {
  const rad = ((h + ANGLE_OFFSET) * Math.PI) / 180;
  const dist = (s / 100) * R;
  return { x: R + Math.cos(rad) * dist, y: R + Math.sin(rad) * dist };
};

// Inverse: pointer position within the wheel back to hue+saturation.
const xyToHS = (x: number, y: number, R: number): { h: number; s: number } => {
  const dx = x - R, dy = y - R;
  const h = wrapHue((Math.atan2(dy, dx) * 180) / Math.PI - ANGLE_OFFSET);
  const s = Math.min(100, (Math.hypot(dx, dy) / R) * 100);
  return { h, s };
};

// Clipboard with a CEF-safe fallback: navigator.clipboard is unavailable in
// the extension's non-secure context, so fall back to a hidden textarea +
// execCommand('copy').
const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

const contrastText = (hex: string): string => {
  const hsl = hexToHsl(hex);
  return hsl && hsl.l < 55 ? '#fff' : '#111';
};

interface Props {
  // When provided, swatches gain a "send to palette" action (Color Palette tab).
  onAddToPalette?: (hexes: string[]) => void;
}

export default function ColorHarmonies({ onAddToPalette }: Props = {}) {
  const [base, setBase] = useState<HSL>(INITIAL_HSL);
  const [hexInput, setHexInput] = useState<string>(hslToHex(INITIAL_HSL));
  const [activeHarmony, setActiveHarmony] = useState<HarmonyKey>(INITIAL_HARMONY);
  const [showAll, setShowAll] = useState(SAVED?.showAll ?? false);
  const [showSliders, setShowSliders] = useState(SAVED?.showSliders ?? false);
  const [wheelSize, setWheelSize] = useState<number>(
    Math.min(WHEEL_MAX, Math.max(WHEEL_MIN, SAVED?.wheelSize ?? WHEEL_DEFAULT))
  );
  const R = wheelSize / 2;
  const wheelRef = useRef<HTMLDivElement>(null);
  const [swatchMenu, setSwatchMenu] = useState<{ x: number; y: number; color: HSL } | null>(null);

  const baseHex = useMemo(() => hslToHex(base), [base]);

  // Persist the config (debounced) whenever it changes, so the next panel open
  // restores it. Skips the very first run to avoid rewriting the file with the
  // values we just loaded.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    const id = window.setTimeout(() => {
      saveColorState({ hex: baseHex, harmony: activeHarmony, showAll, showSliders, wheelSize });
    }, 250);
    return () => window.clearTimeout(id);
  }, [baseHex, activeHarmony, showAll, showSliders, wheelSize]);

  const allHarmonies = useMemo(() => buildAllHarmonies(base), [base]);
  const activeColors = useMemo(() => buildHarmony(base, activeHarmony).colors, [base, activeHarmony]);

  const applyBase = useCallback((next: HSL) => {
    setBase(next);
    setHexInput(hslToHex(next));
  }, []);

  // --- Wheel dragging: hue + saturation from pointer, lightness untouched. ---
  const updateFromPointer = useCallback((clientX: number, clientY: number) => {
    const el = wheelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const { h, s } = xyToHS(clientX - rect.left, clientY - rect.top, R);
    setBase((prev) => {
      const next = { ...prev, h, s };
      setHexInput(hslToHex(next));
      return next;
    });
  }, [R]);

  const handlePointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    updateFromPointer(e.clientX, e.clientY);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    updateFromPointer(e.clientX, e.clientY);
  };

  const commitHex = (raw: string) => {
    const hsl = hexToHsl(raw);
    if (hsl) applyBase(hsl);
    else setHexInput(baseHex); // revert invalid input
  };

  const copy = async (hex: string) => {
    if (await copyText(hex)) toast.success(`Copied ${hex}`);
    else toast.error('Clipboard unavailable.');
  };

  const copyRow = async (colors: HSL[]) => {
    const list = colors.map(hslToHex).join(', ');
    if (await copyText(list)) toast.success('Palette copied.');
    else toast.error('Clipboard unavailable.');
  };

  // Push one or more colors to the Color Palette tab.
  const sendToPalette = (colors: HSL[]) => {
    if (!onAddToPalette) return;
    const hexes = colors.map(hslToHex);
    onAddToPalette(hexes);
    toast.success(hexes.length === 1 ? `Sent ${hexes[0]} to palette.` : `Sent ${hexes.length} colors to palette.`);
  };

  const basePos = hslToXY(base.h, base.s, R);

  return (
    <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>

      {/* ---- Wheel + controls (stacked, wheel centered) ---- */}
      <div className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'stretch' }}>
        {/* Centered wheel with a size handle in the corner */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <div
            ref={wheelRef}
            className="mc-wheel"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            style={{
              position: 'relative', width: wheelSize, height: wheelSize, borderRadius: '50%',
              flexShrink: 0, cursor: 'crosshair', touchAction: 'none',
              // Hue ring (conic) with a white-center saturation falloff on top.
              backgroundImage:
                `radial-gradient(circle at center, hsl(0,0%,${base.l}%) 0%, hsla(0,0%,${base.l}%,0) 70%), ` +
                'conic-gradient(hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))',
            }}
          >
            {/* Companion dots for every color in the active harmony (skip base). */}
            {activeColors.slice(1).map((c, i) => {
              const p = hslToXY(c.h, c.s, R);
              return (
                <div key={i} style={{
                  position: 'absolute', left: p.x - 6, top: p.y - 6, width: 12, height: 12,
                  borderRadius: '50%', backgroundColor: hslToHex(c),
                  border: '2px solid rgba(255,255,255,0.85)', boxShadow: '0 0 3px rgba(0,0,0,0.6)',
                  pointerEvents: 'none',
                }} />
              );
            })}
            {/* Base handle */}
            <div style={{
              position: 'absolute', left: basePos.x - HANDLE / 2, top: basePos.y - HANDLE / 2,
              width: HANDLE, height: HANDLE, borderRadius: '50%', backgroundColor: baseHex,
              border: '3px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.6), 0 1px 4px rgba(0,0,0,0.5)',
              pointerEvents: 'none',
            }} />
          </div>

          {/* Size control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', maxWidth: 260 }}>
            <span style={{ fontSize: '11px', color: 'var(--panel-fg-dim)', flexShrink: 0 }} title="Wheel size">⤡</span>
            <input type="range" min={WHEEL_MIN} max={WHEEL_MAX} value={wheelSize}
              onChange={(e) => setWheelSize(parseInt(e.target.value, 10))} title={`Wheel size ${wheelSize}px`} />
          </div>
        </div>

        {/* Controls column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 34, height: 34, borderRadius: 'var(--radius-md)', backgroundColor: baseHex, border: '1px solid var(--panel-border)', flexShrink: 0 }} />
            <input
              type="text"
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              onBlur={(e) => commitHex(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value); }}
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, padding: '8px', fontFamily: 'monospace', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)' }}
            />
          </div>

          <button onClick={() => setShowSliders((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 2px',
              background: 'none', border: 'none', color: 'var(--panel-fg-muted)',
              fontSize: '11px', cursor: 'pointer', textAlign: 'left',
            }}>
            <span style={{ display: 'inline-block', transform: showSliders ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>▶</span>
            HSL adjustments
          </button>
          {showSliders && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Slider label={`Hue ${Math.round(base.h)}°`} min={0} max={360} value={base.h}
                onChange={(h) => applyBase({ ...base, h })} />
              <Slider label={`Saturation ${Math.round(base.s)}%`} min={0} max={100} value={base.s}
                onChange={(s) => applyBase({ ...base, s })} />
              <Slider label={`Lightness ${Math.round(base.l)}%`} min={0} max={100} value={base.l}
                onChange={(l) => applyBase({ ...base, l })} />
            </div>
          )}
        </div>
      </div>

      {/* ---- Harmony selector + palettes (one card) ---- */}
      <div className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <select
          value={activeHarmony}
          disabled={showAll}
          onChange={(e) => setActiveHarmony(e.target.value as HarmonyKey)}
          style={{
            flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px', cursor: showAll ? 'default' : 'pointer',
            backgroundColor: 'var(--panel-bg-sunken)', color: showAll ? 'var(--panel-fg-dim)' : 'var(--panel-fg)',
            border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', opacity: showAll ? 0.6 : 1,
          }}>
          {ALL_HARMONIES.map((k) => (
            <option key={k} value={k} style={{ backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)' }}>
              {buildHarmony(base, k).label}
            </option>
          ))}
        </select>
        <button onClick={() => setShowAll((v) => !v)} title="Toggle between the selected harmony and all of them"
          style={{
            padding: '6px 10px', fontSize: '11px', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
            backgroundColor: showAll ? 'var(--accent)' : 'var(--panel-bg-sunken)',
            color: showAll ? '#fff' : 'var(--panel-fg-muted)',
            border: `1px solid ${showAll ? 'var(--accent)' : 'var(--panel-border)'}`,
            borderRadius: 'var(--radius-sm)',
          }}>
          {showAll ? 'Show selected' : 'Show all'}
        </button>
      </div>

      {/* ---- Harmony palettes: just the selected one, or all when toggled ---- */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {(showAll ? allHarmonies : allHarmonies.filter((h) => h.key === activeHarmony)).map((harm) => (
          <div key={harm.key} className="mc-fade">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: harm.key === activeHarmony ? 'var(--panel-fg)' : 'var(--panel-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {harm.label}
              </span>
              <div style={{ display: 'flex', gap: '4px' }}>
                {onAddToPalette && (
                  <button onClick={() => sendToPalette(harm.colors)} title="Add this harmony to the Color Palette tab"
                    style={{ fontSize: '10px', padding: '2px 6px', backgroundColor: 'transparent', color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                    → Palette
                  </button>
                )}
                <button onClick={() => copyRow(harm.colors)} title="Copy palette"
                  style={{ fontSize: '10px', padding: '2px 6px', backgroundColor: 'transparent', color: 'var(--panel-fg-dim)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                  Copy all
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '5px', height: 50 }}>
              {harm.colors.map((c, i) => {
                const hex = hslToHex(c);
                return (
                  <div key={i} className="mc-swatch"
                    onClick={(e) => {
                      if (onAddToPalette && (e.altKey || e.shiftKey)) sendToPalette([c]);
                      else copy(hex);
                    }}
                    onMouseDown={(e) => { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); setSwatchMenu({ x: e.clientX, y: e.clientY, color: c }); } }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    title={`${hex} — click to copy · right-click for menu`}
                    style={{
                      flex: 1, backgroundColor: hex, cursor: 'pointer', position: 'relative',
                      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 4,
                      borderRadius: 'var(--radius-md)',
                      boxShadow: i === 0 ? '0 0 0 2px var(--panel-fg)' : 'inset 0 0 0 1px rgba(0,0,0,0.25)',
                    }}>
                    <span style={{ fontSize: '9px', fontFamily: 'monospace', color: contrastText(hex), opacity: 0.9 }}>
                      {hex.replace('#', '')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      </div>

      {swatchMenu && (() => {
        const c = swatchMenu.color;
        const hex = hslToHex(c);
        const items: ContextMenuItem[] = [];
        if (onAddToPalette) items.push({ id: 'send', icon: '→', label: 'Send to palette', onSelect: () => sendToPalette([c]) });
        items.push({ id: 'copy', icon: '⧉', label: `Copy ${hex}`, onSelect: () => copy(hex) });
        items.push({ id: 'key', icon: '◎', label: 'Set as key color', divider: !!onAddToPalette, onSelect: () => applyBase(c) });
        return <ContextMenu x={swatchMenu.x} y={swatchMenu.y} items={items} onClose={() => setSwatchMenu(null)} />;
      })()}
    </div>
  );
}

function Slider({ label, min, max, value, onChange }: {
  label: string; min: number; max: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <label style={{ fontSize: '11px', color: 'var(--panel-fg-muted)' }}>{label}</label>
      <input type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}
