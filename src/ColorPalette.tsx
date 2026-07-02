import { useEffect, useMemo, useRef, useState } from 'react';
import { hexToHsl } from './utils/color';
import { applyColorToSelection, extractColorsFromSelection } from './utils/aeColor';
import { exportPalette, importPalette } from './utils/paletteIO';
import { FORMAT_LABELS, type ExportFormat } from './utils/colorFormats';
import {
  listPalettes, loadPalette, savePalette, deletePalette,
} from './utils/storage';
import { copyText } from './utils/clipboard';
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu';
import { toast } from './utils/toast';

const contrastText = (hex: string): string => {
  const hsl = hexToHsl(hex);
  return hsl && hsl.l < 55 ? '#fff' : '#111';
};

const norm = (hex: string) => '#' + hex.replace(/^#/, '').toUpperCase();

interface Props {
  colors: string[];
  setColors: React.Dispatch<React.SetStateAction<string[]>>;
  name: string;
  setName: React.Dispatch<React.SetStateAction<string>>;
}

export default function ColorPalette({ colors, setColors, name, setName }: Props) {
  const [saved, setSaved] = useState<string[]>([]);
  const [newHex, setNewHex] = useState('#3498db');
  const [format, setFormat] = useState<ExportFormat>('ase');
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  // Hidden native color input reused for the "Edit color…" action.
  const editInputRef = useRef<HTMLInputElement>(null);
  const editIndexRef = useRef<number>(-1);

  const refreshList = () => setSaved(listPalettes());
  useEffect(() => { refreshList(); }, []);

  const addColor = (hex: string) => {
    const h = norm(hex);
    if (!/^#[0-9A-F]{6}$/.test(h)) { toast.error('Enter a valid hex color.'); return; }
    setColors((prev) => (prev.includes(h) ? prev : [...prev, h]));
  };

  const removeColor = (i: number) => setColors((prev) => prev.filter((_, idx) => idx !== i));

  const setColorAt = (i: number, hex: string) => {
    const h = norm(hex);
    setColors((prev) => prev.map((c, idx) => (idx === i ? h : c)));
  };

  const copyHex = async (hex: string) => {
    if (await copyText(hex)) toast.success(`Copied ${hex}`);
    else toast.error('Clipboard unavailable.');
  };

  // Opens the native color picker seeded with the swatch's current value.
  const editColor = (i: number) => {
    editIndexRef.current = i;
    const input = editInputRef.current;
    if (!input) return;
    input.value = colors[i].toLowerCase();
    input.click();
  };

  // Click = fill, Ctrl/Cmd-click = stroke, Alt-click = remove swatch.
  const onSwatchClick = (e: React.MouseEvent, hex: string, i: number) => {
    if (e.altKey) { removeColor(i); return; }
    applyColorToSelection(hex, e.ctrlKey || e.metaKey ? 'stroke' : 'fill');
  };

  // CEF/AE doesn't reliably deliver the `contextmenu` DOM event to the page,
  // so we open on a right-button mousedown (button 2) — the same trigger the
  // original ExtendScript used. stopPropagation keeps any trailing native
  // contextmenu event from reaching ContextMenu's window-level close handler.
  const openMenu = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, index: i });
  };

  const handleExtract = async () => {
    const extracted = await extractColorsFromSelection();
    if (!extracted) return;
    setColors((prev) => {
      const seen = new Set(prev.map((c) => c.toUpperCase()));
      const merged = [...prev];
      for (const c of extracted) { const n = norm(c); if (!seen.has(n)) { seen.add(n); merged.push(n); } }
      return merged;
    });
    toast.success(`Extracted ${extracted.length} color${extracted.length === 1 ? '' : 's'}.`);
  };

  const handleSave = () => {
    if (!colors.length) { toast.info('Nothing to save — palette is empty.'); return; }
    const trimmed = name.trim() || 'Untitled';
    if (savePalette({ name: trimmed, colors })) {
      toast.success(`Saved "${trimmed}".`);
      refreshList();
    } else {
      toast.error('Could not save palette.');
    }
  };

  const handleLoad = (n: string) => {
    if (!n) return;
    const p = loadPalette(n);
    if (!p) { toast.error('Could not load palette.'); return; }
    setColors(p.colors.map(norm));
    setName(p.name);
  };

  const handleDelete = () => {
    const n = name.trim();
    if (!saved.includes(n)) { toast.info('No saved palette with that name.'); return; }
    if (deletePalette(n)) { toast.success(`Deleted "${n}".`); refreshList(); }
    else toast.error('Could not delete palette.');
  };

  const handleImport = () => {
    const p = importPalette();
    if (!p) return;
    setColors(p.colors.map(norm));
    setName(p.name);
    toast.success(`Imported ${p.colors.length} color${p.colors.length === 1 ? '' : 's'}.`);
  };

  const isKnown = useMemo(() => saved.includes(name.trim()), [saved, name]);

  return (
    <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ---- Palette management card ---- */}
      <div className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* ---- Saved palettes ---- */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <select
          value={isKnown ? name.trim() : ''}
          onChange={(e) => handleLoad(e.target.value)}
          style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
          <option value="" style={{ backgroundColor: 'var(--panel-bg-elev)' }}>{saved.length ? 'Load palette…' : 'No saved palettes'}</option>
          {saved.map((n) => (
            <option key={n} value={n} style={{ backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)' }}>{n}</option>
          ))}
        </select>
      </div>

      {/* Name + save/delete */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <input
          type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Palette name"
          style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}
        />
        <button onClick={handleSave} title="Save palette to collection"
          style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', backgroundColor: 'var(--success)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)' }}>Save</button>
        <button onClick={handleDelete} disabled={!isKnown} title="Delete this saved palette"
          style={{ padding: '6px 10px', fontSize: '11px', cursor: isKnown ? 'pointer' : 'default', backgroundColor: 'transparent', color: isKnown ? 'var(--danger)' : 'var(--panel-fg-dim)', border: `1px solid ${isKnown ? 'var(--danger)' : 'var(--panel-border)'}`, borderRadius: 'var(--radius-sm)' }}>Delete</button>
      </div>

      {/* ---- Add color / extract ---- */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(newHex) ? newHex : '#000000'} onChange={(e) => setNewHex(e.target.value)}
          style={{ width: 34, height: 30, padding: 0, border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
        <input type="text" value={newHex} onChange={(e) => setNewHex(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addColor(newHex); }} spellCheck={false} placeholder="#RRGGBB"
          style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontFamily: 'monospace', fontSize: '12px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }} />
        <button onClick={() => addColor(newHex)} title="Add color to palette"
          style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', backgroundColor: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)' }}>Add</button>
        <button onClick={handleExtract} title="Extract colors from the selected layers"
          style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>Extract</button>
      </div>
      </div>

      {/* ---- Swatch grid ---- */}
      <div>
        <div style={{ fontSize: '10px', color: 'var(--panel-fg-dim)', marginBottom: '6px' }}>
          {colors.length
            ? 'Click = fill · Ctrl = stroke · Alt = remove · Right-click = menu'
            : 'No colors yet — add one, extract from a selection, or import a palette.'}
        </div>
        {colors.length > 0 && (
          <div className="mc-fade" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))', gap: '6px' }}>
            {colors.map((hex, i) => (
              <div key={hex + i} className="mc-swatch" onClick={(e) => onSwatchClick(e, hex, i)}
                onMouseDown={(e) => { if (e.button === 2) openMenu(e, i); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                title={`${hex}\nClick: fill · Ctrl: stroke · Alt: remove · Right-click: menu`}
                style={{ height: 44, borderRadius: 'var(--radius-md)', backgroundColor: hex, cursor: 'pointer', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 3, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)' }}>
                <span style={{ fontSize: '8px', fontFamily: 'monospace', color: contrastText(hex), opacity: 0.9 }}>{hex.replace('#', '')}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Export / import card ---- */}
      <div className="mc-card" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}
          style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: '12px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
          {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((k) => (
            <option key={k} value={k} style={{ backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)' }}>{FORMAT_LABELS[k]}</option>
          ))}
        </select>
        <button onClick={() => exportPalette(format, colors, name.trim() || 'palette')}
          style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', backgroundColor: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)' }}>Export…</button>
        <button onClick={handleImport} title="Import an ASE or JSON palette"
          style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>Import…</button>
      </div>

      {/* Hidden native picker driven by the "Edit color…" menu action. */}
      <input ref={editInputRef} type="color" tabIndex={-1} aria-hidden
        onChange={(e) => { if (editIndexRef.current >= 0) setColorAt(editIndexRef.current, e.target.value); }}
        style={{ position: 'fixed', width: 0, height: 0, opacity: 0, pointerEvents: 'none', left: -9999 }} />

      {menu && (() => {
        const hex = colors[menu.index];
        if (!hex) return null;
        const items: ContextMenuItem[] = [
          { id: 'copy', icon: '⧉', label: `Copy ${hex}`, onSelect: () => copyHex(hex) },
          { id: 'fill', icon: '▣', label: 'Apply as fill', onSelect: () => applyColorToSelection(hex, 'fill') },
          { id: 'stroke', icon: '◻', label: 'Apply as stroke', onSelect: () => applyColorToSelection(hex, 'stroke') },
          { id: 'edit', icon: '✎', label: 'Edit color…', divider: true, onSelect: () => editColor(menu.index) },
          { id: 'remove', icon: '×', label: 'Remove', onSelect: () => removeColor(menu.index) },
        ];
        return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />;
      })()}
    </div>
  );
}
