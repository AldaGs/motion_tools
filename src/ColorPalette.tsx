import { useMemo, useRef, useState } from 'react';
import { applyColorToSelection, extractColorsFromSelection } from './utils/aeColor';
import { listPalettes, loadPalette, savePalette, deletePalette } from './utils/storage';
import { copyText } from './utils/clipboard';
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu';
import FeatherIcon from './components/FeatherIcon';
import { toast } from './utils/toast';

const norm = (hex: string) => '#' + hex.replace(/^#/, '').toUpperCase();

interface Props {
  colors: string[];
  setColors: React.Dispatch<React.SetStateAction<string[]>>;
  name: string;
  setName: React.Dispatch<React.SetStateAction<string>>;
  // Notifies the parent whether the working palette is the project-embedded one
  // (drives the auto-sync-to-project behavior).
  onLinkChange: (linked: boolean) => void;
}

export default function ColorPalette({ colors, setColors, name, setName, onLinkChange }: Props) {
  const [saved, setSaved] = useState<string[]>(() => listPalettes());
  const [newHex, setNewHex] = useState('#3498db');
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  // Hidden native color input reused for the "Edit color…" action.
  const editInputRef = useRef<HTMLInputElement>(null);
  const editIndexRef = useRef<number>(-1);
  // Drag-to-reorder swatches.
  const dragIndex = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const moveColor = (from: number, to: number) => {
    if (from === to) return;
    setColors((prev) => { const a = [...prev]; const [m] = a.splice(from, 1); a.splice(to, 0, m); return a; });
  };

  const refreshList = () => setSaved(listPalettes());

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

  // Save prompts for a name (no dedicated name field anymore), defaulting to the
  // current one. Guarded so an environment without window.prompt just saves
  // under the existing name rather than breaking.
  const handleSave = () => {
    if (!colors.length) { toast.info('Nothing to save — palette is empty.'); return; }
    let target = name.trim();
    try {
      const r = window.prompt('Save palette as', target || 'Untitled');
      if (r === null) return;            // cancelled (only when prompt is supported)
      if (typeof r === 'string' && r.trim()) target = r.trim();
    } catch { /* prompt unsupported — keep current name */ }
    if (!target) target = 'Untitled';
    if (savePalette({ name: target, colors })) {
      setName(target);
      toast.success(`Saved "${target}".`);
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
    onLinkChange(false);
  };

  const handleDelete = () => {
    const n = name.trim();
    if (!saved.includes(n)) { toast.info('Load a saved palette to delete it.'); return; }
    if (deletePalette(n)) { toast.success(`Deleted "${n}".`); refreshList(); }
    else toast.error('Could not delete palette.');
  };

  const isKnown = useMemo(() => saved.includes(name.trim()), [saved, name]);

  const inp: React.CSSProperties = { flex: 1, minWidth: 0, padding: '4px 6px', fontSize: '12px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' };

  return (
    <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>

      {/* ---- Palette management ---- */}
      <div className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
          <select value={isKnown ? name.trim() : ''} onChange={(e) => handleLoad(e.target.value)} title={name} style={inp}>
            <option value="" style={{ backgroundColor: 'var(--panel-bg-elev)' }}>{saved.length ? 'Load palette…' : 'No saved palettes'}</option>
            {saved.map((n) => (
              <option key={n} value={n} style={{ backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)' }}>{n}</option>
            ))}
          </select>
          <button className="mc-iconbtn" onClick={handleSave} title="Save palette to collection (asks for a name)"
            style={{ backgroundColor: 'var(--success)', color: '#fff', border: 'none' }}><FeatherIcon name="save" size={15} /></button>
          <button className="mc-iconbtn" onClick={handleDelete} disabled={!isKnown} title="Delete the loaded palette"
            style={{ backgroundColor: 'transparent', color: isKnown ? 'var(--danger)' : 'var(--panel-fg-dim)', border: `1px solid ${isKnown ? 'var(--danger)' : 'var(--panel-border)'}` }}><FeatherIcon name="trash" size={15} /></button>
        </div>
        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
          <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(newHex) ? newHex : '#000000'} onChange={(e) => setNewHex(e.target.value)}
            style={{ width: 28, height: 28, padding: 0, border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
          <input type="text" value={newHex} onChange={(e) => setNewHex(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addColor(newHex); }} spellCheck={false} placeholder="#RRGGBB"
            style={{ ...inp, fontFamily: 'monospace' }} />
          <button className="mc-iconbtn" onClick={() => addColor(newHex)} title="Add color to palette"
            style={{ backgroundColor: 'var(--accent)', color: '#fff', border: 'none' }}><FeatherIcon name="plus-circle" size={15} /></button>
          <button className="mc-iconbtn" onClick={handleExtract} title="Extract colors from the selected layers"
            style={{ backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)' }}><FeatherIcon name="droplet" size={15} /></button>
        </div>
      </div>

      {/* ---- Swatch grid ---- */}
      <div>
        <div style={{ fontSize: '9px', color: 'var(--panel-fg-dim)', marginBottom: '4px' }}>
          {colors.length
            ? 'Click fill · Ctrl stroke · Alt remove · drag reorder · R-click ⋯'
            : 'No colors — add, extract, or import.'}
        </div>
        {colors.length > 0 && (
          <div className="mc-fade" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))', gap: '4px' }}>
            {colors.map((hex, i) => (
              <div key={hex + i} className="mc-swatch" onClick={(e) => onSwatchClick(e, hex, i)}
                onMouseDown={(e) => { if (e.button === 2) openMenu(e, i); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                draggable
                onDragStart={(e) => { dragIndex.current = i; e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); if (dragOver !== i) setDragOver(i); }}
                onDragLeave={() => setDragOver((p) => (p === i ? null : p))}
                onDrop={(e) => { e.preventDefault(); if (dragIndex.current != null) moveColor(dragIndex.current, i); dragIndex.current = null; setDragOver(null); }}
                onDragEnd={() => { dragIndex.current = null; setDragOver(null); }}
                title={`${hex}\nClick: fill · Ctrl: stroke · Alt: remove · Right-click: menu · Drag to reorder`}
                style={{ height: 30, borderRadius: 'var(--radius-sm)', backgroundColor: hex, cursor: 'pointer', boxShadow: dragOver === i ? '0 0 0 2px var(--accent)' : 'inset 0 0 0 1px rgba(0,0,0,0.3)' }} />
            ))}
          </div>
        )}
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
