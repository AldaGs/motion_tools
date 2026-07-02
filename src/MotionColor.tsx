import { useCallback, useEffect, useRef, useState } from 'react';
import ColorHarmonies from './ColorHarmonies';
import ColorPalette from './ColorPalette';
import {
  loadPaletteWorkingState, savePaletteWorkingState, listPalettes, savePalette,
  loadColorSettings, saveColorSettings, type ColorSettings,
} from './utils/storage';
import './motionColor.css';

type Tab = 'wheel' | 'palette';

const norm = (hex: string) => '#' + hex.replace(/^#/, '').toUpperCase();

// Seed once at module scope so useState restores synchronously (no flash of an
// empty palette on open).
const SAVED_PALETTE = loadPaletteWorkingState();
const SAVED_SETTINGS = loadColorSettings();

export default function MotionColor() {
  const [tab, setTab] = useState<Tab>('wheel');
  // The working palette lives here so the Wheel tab can push colors into it.
  const [paletteColors, setPaletteColors] = useState<string[]>(SAVED_PALETTE?.colors.map(norm) ?? []);
  const [paletteName, setPaletteName] = useState(SAVED_PALETTE?.name ?? 'Untitled');
  const [settings, setSettings] = useState<ColorSettings>(SAVED_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);

  const updateSetting = <K extends keyof ColorSettings>(key: K, value: ColorSettings[K]) => {
    setSettings((prev) => { const next = { ...prev, [key]: value }; saveColorSettings(next); return next; });
  };

  // Auto-save the working palette (debounced), skipping the first run so we
  // don't rewrite the file with what we just loaded. The working-state write
  // is always on (session restore, no data risk). Writing through to a *named*
  // palette is gated behind the "Auto-update open palettes" setting.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    const id = window.setTimeout(() => {
      savePaletteWorkingState({ name: paletteName, colors: paletteColors });
      const trimmed = paletteName.trim();
      if (settings.autoUpdateOpen && trimmed && listPalettes().includes(trimmed)) {
        savePalette({ name: trimmed, colors: paletteColors });
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [paletteColors, paletteName, settings.autoUpdateOpen]);

  const addToPalette = useCallback((hexes: string[]) => {
    setPaletteColors((prev) => {
      const seen = new Set(prev.map((c) => c.toUpperCase()));
      const merged = [...prev];
      for (const h of hexes) { const n = norm(h); if (!seen.has(n.toUpperCase())) { seen.add(n.toUpperCase()); merged.push(n); } }
      return merged;
    });
  }, []);

  const tabBtn = (id: Tab, label: string, badge?: number) => {
    const active = tab === id;
    return (
      <button onClick={() => setTab(id)} className={`mc-tab${active ? ' is-active' : ''}`}
        style={{
          flex: 1, padding: '9px 10px', fontSize: '12px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
          backgroundColor: active ? 'var(--panel-bg-elev)' : 'transparent',
          color: active ? 'var(--panel-fg)' : 'var(--panel-fg-muted)',
          border: 'none',
          fontWeight: active ? 600 : 400, letterSpacing: '0.3px',
        }}>
        {label}
        {badge ? (
          <span style={{ fontSize: '9px', fontWeight: 600, color: '#fff', backgroundColor: 'var(--accent)', borderRadius: '8px', padding: '1px 5px', lineHeight: 1.4 }}>{badge}</span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="mc-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--panel-bg)', color: 'var(--panel-fg)', overflow: 'hidden' }}>
      <div style={{ position: 'relative', display: 'flex', flexShrink: 0, alignItems: 'stretch', backgroundColor: 'var(--panel-bg-sunken)', borderBottom: '1px solid var(--panel-border)' }}>
        {tabBtn('wheel', 'Color Wheel')}
        {tabBtn('palette', 'Color Palette', paletteColors.length)}
        <button onClick={() => setShowSettings((v) => !v)} title="Motion Color settings"
          style={{
            flexShrink: 0, width: 34, cursor: 'pointer', fontSize: '14px',
            backgroundColor: showSettings ? 'var(--panel-bg-elev)' : 'transparent',
            color: showSettings ? 'var(--panel-fg)' : 'var(--panel-fg-muted)',
            border: 'none', borderLeft: '1px solid var(--panel-border)',
          }}>⚙</button>

        {showSettings && (
          <>
            {/* Click-catcher to dismiss the popover. */}
            <div onClick={() => setShowSettings(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
            <div style={{
              position: 'absolute', top: '100%', right: 4, zIndex: 41, marginTop: 4, minWidth: 230,
              backgroundColor: 'var(--panel-bg-elev)', border: '1px solid var(--panel-border)',
              borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', padding: '10px',
              display: 'flex', flexDirection: 'column', gap: '10px',
            }}>
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--panel-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Settings</div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.autoUpdateOpen}
                  onChange={(e) => updateSetting('autoUpdateOpen', e.target.checked)}
                  style={{ marginTop: '2px', flexShrink: 0 }} />
                <span>
                  Auto-update open palettes
                  <span style={{ display: 'block', fontSize: '10px', color: 'var(--panel-fg-dim)', marginTop: '2px' }}>
                    Save edits straight to a loaded palette's file. Off keeps edits as a draft until you press Save.
                  </span>
                </span>
              </label>
            </div>
          </>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Both stay mounted so palette edits + wheel state persist across tab switches. */}
        <div style={{ display: tab === 'wheel' ? 'block' : 'none' }}>
          <ColorHarmonies onAddToPalette={addToPalette} />
        </div>
        <div style={{ display: tab === 'palette' ? 'block' : 'none' }}>
          <ColorPalette colors={paletteColors} setColors={setPaletteColors} name={paletteName} setName={setPaletteName} />
        </div>
      </div>
    </div>
  );
}
