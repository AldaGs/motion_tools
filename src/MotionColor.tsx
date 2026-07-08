import { useCallback, useEffect, useRef, useState } from 'react';
import ColorHarmonies from './ColorHarmonies';
import ColorPalette from './ColorPalette';
import {
  loadPaletteWorkingState, savePaletteWorkingState, listPalettes, savePalette,
  loadColorSettings, saveColorSettings, type ColorSettings,
  loadAiColorClip, removeFromAiColorClip,
} from './utils/storage';
import { syncPaletteToProject, projectPaletteExists, getProjectPaletteColors } from './utils/aeColor';
import { exportPalette, importPalette } from './utils/paletteIO';
import { FORMAT_LABELS, type ExportFormat } from './utils/colorFormats';
import { toast } from './utils/toast';
import FeatherIcon from './components/FeatherIcon';
import './motionColor.css';

type Tab = 'wheel' | 'palette';

const norm = (hex: string) => '#' + hex.replace(/^#/, '').toUpperCase();

// Seed once at module scope so useState restores synchronously (no flash of an
// empty palette on open).
const SAVED_PALETTE = loadPaletteWorkingState();
const SAVED_SETTINGS = loadColorSettings();

export default function MotionColor() {
  const [tab, setTab] = useState<Tab>('palette');
  // The working palette lives here so the Wheel tab can push colors into it.
  const [paletteColors, setPaletteColors] = useState<string[]>(SAVED_PALETTE?.colors.map(norm) ?? []);
  const [paletteName, setPaletteName] = useState(SAVED_PALETTE?.name ?? 'Untitled');
  const [settings, setSettings] = useState<ColorSettings>(SAVED_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  // True while the working palette is the one embedded in the project — gates
  // the "auto-sync to project" behavior so it only pushes the project palette.
  const [linkedToProject, setLinkedToProject] = useState(false);
  const [projectHas, setProjectHas] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('ase');

  const updateSetting = <K extends keyof ColorSettings>(key: K, value: ColorSettings[K]) => {
    setSettings((prev) => { const next = { ...prev, [key]: value }; saveColorSettings(next); return next; });
  };

  // Suppress CEF's built-in right-click menu (Back / Forward / Print / View
  // source) across the whole panel — our swatches provide their own menus.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  }, []);

  // Detect an embedded project palette when the panel opens, and re-check each
  // time the settings menu is opened (the active project may have changed).
  useEffect(() => { if (showSettings) projectPaletteExists().then(setProjectHas); }, [showSettings]);

  // On mount, light up the "linked" chain if the project already carries an
  // embedded palette whose colors match the restored working palette — so a
  // fresh panel open reflects the link instead of waiting for an Embed/Pull.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const embedded = await getProjectPaletteColors(true); // quiet: no toast if none
      if (cancelled || !embedded) return;
      const a = embedded.map((h) => norm(h).toUpperCase());
      const b = paletteColors.map((h) => norm(h).toUpperCase());
      if (a.length === b.length && a.every((h, i) => h === b[i])) {
        setProjectHas(true);
        setLinkedToProject(true);
      }
    })();
    return () => { cancelled = true; };
    // Intentionally mount-only: a one-shot check against the restored palette.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEmbed = async () => {
    if (!paletteColors.length) { toast.info('Palette is empty — nothing to embed.'); return; }
    if (await syncPaletteToProject(paletteColors)) { setProjectHas(true); setLinkedToProject(true); }
  };
  const handlePull = async () => {
    const c = await getProjectPaletteColors();
    if (!c) return;
    setPaletteColors(c.map(norm));
    setPaletteName('Project Palette');
    setProjectHas(true);
    setLinkedToProject(true);
    toast.success(`Loaded ${c.length} color${c.length === 1 ? '' : 's'} from project.`);
  };

  const handleFromAi = () => {
    const clip = loadAiColorClip();
    if (!clip || clip.colors.length === 0) {
      toast.info('No AI color clip found. Use the Palette button in MTAG Switch (Illustrator) first.');
      return;
    }
    // Merge: deduplicate against existing palette, counting only what's new.
    const normalized = clip.colors.map(norm);
    const added: string[] = [];
    setPaletteColors((prev) => {
      const seen = new Set(prev.map(c => c.toUpperCase()));
      const merged = [...prev];
      for (const h of normalized) {
        if (!seen.has(h.toUpperCase())) { seen.add(h.toUpperCase()); merged.push(h); added.push(h); }
      }
      return merged;
    });
    // Consume the inserted colors so they aren't re-added on the next press.
    if (settings.dedupAiAfterInsert) removeFromAiColorClip(normalized);
    if (added.length === 0) {
      toast.info(`All ${normalized.length} AI color${normalized.length === 1 ? '' : 's'} already in palette.`);
    } else {
      toast.success(`Added ${added.length} color${added.length === 1 ? '' : 's'} from AI.`);
    }
    if (tab !== 'palette') setTab('palette');
  };
  const handleImport = () => {
    const p = importPalette();
    if (!p) return;
    setPaletteColors(p.colors.map(norm));
    setPaletteName(p.name);
    setLinkedToProject(false);
    toast.success(`Imported ${p.colors.length} color${p.colors.length === 1 ? '' : 's'}.`);
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

  // Auto-push edits to the embedded project palette when linked + enabled.
  // Longer debounce than the disk write — each push rewrites the project's XMP
  // metadata, so we wait for edits to settle. Skips first run (same as above).
  const didMountSync = useRef(false);
  useEffect(() => {
    if (!didMountSync.current) { didMountSync.current = true; return; }
    if (!settings.autoSyncProject || !linkedToProject || paletteColors.length === 0) return;
    const id = window.setTimeout(() => {
      syncPaletteToProject(paletteColors, 8, true); // quiet
    }, 800);
    return () => window.clearTimeout(id);
  }, [paletteColors, settings.autoSyncProject, linkedToProject]);

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
          flex: 1, padding: '6px 10px', fontSize: '12px', cursor: 'pointer',
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
        {tabBtn('palette', 'Color Palette', paletteColors.length)}
        {tabBtn('wheel', 'Color Wheel')}
        <button onClick={() => setShowSettings((v) => !v)} title="Motion Color settings"
          style={{
            flexShrink: 0, width: 34, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: showSettings ? 'var(--panel-bg-elev)' : 'transparent',
            color: showSettings ? 'var(--panel-fg)' : 'var(--panel-fg-muted)',
            border: 'none', borderLeft: '1px solid var(--panel-border)',
          }}><FeatherIcon name="settings" size={15} /></button>

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
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.autoSyncProject}
                  onChange={(e) => updateSetting('autoSyncProject', e.target.checked)}
                  style={{ marginTop: '2px', flexShrink: 0 }} />
                <span>
                  Auto-sync project palette
                  <span style={{ display: 'block', fontSize: '10px', color: 'var(--panel-fg-dim)', marginTop: '2px' }}>
                    When a project palette is loaded, push edits into the project metadata automatically.
                  </span>
                </span>
              </label>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                <input type="checkbox" checked={settings.dedupAiAfterInsert}
                  onChange={(e) => updateSetting('dedupAiAfterInsert', e.target.checked)}
                  style={{ marginTop: '2px', flexShrink: 0 }} />
                <span>
                  Dedup colors from AI after insert
                  <span style={{ display: 'block', fontSize: '10px', color: 'var(--panel-fg-dim)', marginTop: '2px' }}>
                    Remove colors from the AI clip once inserted, so pressing From&nbsp;AI again only brings in newly picked colors.
                  </span>
                </span>
              </label>

              {/* Project palette */}
              <div style={{ height: 1, backgroundColor: 'var(--panel-border)' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--panel-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Project palette</span>
                <span style={{ fontSize: '10px', color: projectHas ? 'var(--success)' : 'var(--panel-fg-dim)' }}>{projectHas ? '● embedded' : '○ none'}</span>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button onClick={handleEmbed} title="Embed / update this palette in the project"
                  style={{ flex: 1, padding: '6px', fontSize: '11px', cursor: 'pointer', backgroundColor: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)' }}>Embed</button>
                <button onClick={handlePull} disabled={!projectHas} title="Load the palette embedded in this project"
                  style={{ flex: 1, padding: '6px', fontSize: '11px', cursor: projectHas ? 'pointer' : 'default', backgroundColor: projectHas ? 'var(--panel-bg-sunken)' : 'transparent', color: projectHas ? 'var(--panel-fg)' : 'var(--panel-fg-dim)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>Pull</button>
              </div>

              {/* Export / import */}
              <div style={{ height: 1, backgroundColor: 'var(--panel-border)' }} />
              <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--panel-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Export / import</div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}
                  style={{ flex: 1, minWidth: 0, padding: '5px 6px', fontSize: '11px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
                  {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((k) => (
                    <option key={k} value={k} style={{ backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)' }}>{FORMAT_LABELS[k]}</option>
                  ))}
                </select>
                <button className="mc-iconbtn" onClick={() => exportPalette(format, paletteColors, paletteName.trim() || 'palette')} title="Export palette to file"
                  style={{ backgroundColor: 'var(--accent)', color: '#fff', border: 'none' }}><FeatherIcon name="save" size={15} /></button>
                <button className="mc-iconbtn" onClick={handleImport} title="Import an ASE or JSON palette"
                  style={{ backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)' }}><FeatherIcon name="folder-plus" size={15} /></button>
              </div>
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
          <ColorPalette colors={paletteColors} setColors={setPaletteColors} name={paletteName} setName={setPaletteName}
            onLinkChange={setLinkedToProject} linked={linkedToProject} onFromAi={handleFromAi} />
        </div>
      </div>
    </div>
  );
}
