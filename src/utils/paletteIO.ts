// Native save/open for palette export/import. Text goes through CEP's fs;
// binary (ASE/ACO) uses Node's fs + Buffer so bytes survive intact.
import { buildExport, parseAseBytes, type ExportFormat } from './colorFormats';
import { toast } from './toast';

const startDir = (): string => {
  try {
    if (typeof window.CSInterface !== 'undefined') {
      const cs = new window.CSInterface();
      let p = String(cs.getSystemPath(window.SystemPath.USER_DATA) || '');
      p = p.replace(/^file:\/{0,3}/i, '');
      try { p = decodeURIComponent(p); } catch {}
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
      return p.replace(/\\/g, '/');
    }
  } catch {}
  return '';
};

const bare = (s: string) => s.replace(/[^\w\-]+/g, '-').toLowerCase() || 'palette';

export const exportPalette = (format: ExportFormat, hexes: string[], paletteName: string) => {
  if (typeof window.cep === 'undefined') { toast.error('Export requires the CEP environment.'); return; }
  if (!hexes.length) { toast.info('Palette is empty.'); return; }
  try {
    const built = buildExport(format, hexes, paletteName);
    const suggested = `${bare(paletteName)}.${built.ext}`;
    const dir = startDir();
    const initial = dir ? `${dir}/${suggested}` : suggested;
    const res = window.cep.fs.showSaveDialogEx
      ? window.cep.fs.showSaveDialogEx('Export Palette', dir, [built.ext], suggested, initial)
      : window.cep.fs.showSaveDialog('Export Palette', dir, [built.ext], suggested);
    if (!res || res.err !== 0 || !res.data) return; // cancelled

    let target = String(res.data).replace(/\\/g, '/');
    if (!new RegExp(`\\.${built.ext}$`, 'i').test(target)) target += '.' + built.ext;

    const fs = window.require('fs');
    if (built.binary) {
      // Node's Buffer is global at runtime (nodejs enabled) but untyped here.
      const NodeBuffer = (globalThis as any).Buffer;
      fs.writeFileSync(target, NodeBuffer.from(built.data as Uint8Array));
    } else {
      fs.writeFileSync(target, built.data as string, 'utf8');
    }
    toast.success('Exported ' + target.split('/').pop());
  } catch (err) {
    toast.error('Export failed: ' + (err as Error).message);
  }
};

// Opens a picker for .ase/.json and returns { name, colors } or null.
export const importPalette = (): { name: string; colors: string[] } | null => {
  if (typeof window.cep === 'undefined') { toast.error('Import requires the CEP environment.'); return null; }
  try {
    const res = window.cep.fs.showOpenDialog(false, false, 'Import Palette', startDir(), ['ase', 'json']);
    if (!res || res.err !== 0 || !res.data || res.data.length === 0) return null;
    const path = String(res.data[0]).replace(/\\/g, '/');
    const stem = (path.split('/').pop() || 'palette').replace(/\.[^.]+$/, '');
    const fs = window.require('fs');

    if (/\.ase$/i.test(path)) {
      const buf: Uint8Array = new Uint8Array(fs.readFileSync(path));
      const hexes = parseAseBytes(buf).map((h) => '#' + h);
      if (!hexes.length) { toast.error('No colors found in ASE file.'); return null; }
      return { name: stem, colors: hexes };
    }

    // JSON — accept either our named-color shape or a plain string array.
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    let colors: string[] = [];
    if (Array.isArray(parsed)) colors = parsed;
    else if (Array.isArray(parsed?.colors)) {
      colors = parsed.colors.map((c: any) => (typeof c === 'string' ? c : c?.hex)).filter(Boolean);
    }
    colors = colors.map((c) => '#' + String(c).replace(/^#/, ''));
    if (!colors.length) { toast.error('No colors found in file.'); return null; }
    return { name: typeof parsed?.name === 'string' ? parsed.name : stem, colors };
  } catch (err) {
    toast.error('Import failed: ' + (err as Error).message);
    return null;
  }
};
