// Bridge to the color functions in jsx/hostscript.jsx. Keeps the ExtendScript
// string-building (and toast routing for Error:/Warning: prefixes) out of the
// React components.
import { evalScript, isCEPEnvironment } from './adobe';
import { toast } from './toast';

// Escape a value into an ExtendScript string literal.
const lit = (s: string) => JSON.stringify(String(s));

// Surface an "Error:"/"Warning:" prefixed result as a toast. Returns true when
// the call succeeded (no error/warning prefix).
const report = (result: string, successMsg?: string): boolean => {
  if (typeof result === 'string' && result.indexOf('Error:') === 0) {
    toast.error(result.slice(6).trim());
    return false;
  }
  if (typeof result === 'string' && result.indexOf('Warning:') === 0) {
    toast.info(result.slice(8).trim());
    return false;
  }
  if (successMsg) toast.success(successMsg);
  else if (typeof result === 'string' && result.trim()) toast.success(result.trim());
  return true;
};

export const applyColorToSelection = async (hex: string, mode: 'fill' | 'stroke'): Promise<boolean> => {
  if (!isCEPEnvironment()) { toast.error('Only works inside After Effects.'); return false; }
  const result = await evalScript(`applyColorToSelection(${lit(hex)}, ${lit(mode)})`);
  return report(result);
};

// Parse a host result that is either "Error:"/"Warning:" or a JSON hex array.
// `quiet` suppresses the "warning" toast (used for silent existence probes).
const parseHexArrayResult = (result: string, quiet = false): string[] | null => {
  if (result.indexOf('Error:') === 0) { toast.error(result.slice(6).trim()); return null; }
  if (result.indexOf('Warning:') === 0) { if (!quiet) toast.info(result.slice(8).trim()); return null; }
  try {
    const arr = JSON.parse(result);
    if (!Array.isArray(arr)) return null;
    return arr.map((h: string) => '#' + String(h).replace(/^#/, ''));
  } catch {
    toast.error('Could not read colors from After Effects.');
    return null;
  }
};

// Returns an array of '#'-prefixed hex strings extracted from the selection,
// or null if nothing was extracted / an error occurred (already toasted).
export const extractColorsFromSelection = async (): Promise<string[] | null> => {
  if (!isCEPEnvironment()) { toast.error('Only works inside After Effects.'); return null; }
  const hexes = parseHexArrayResult(await evalScript('extractColorsFromSelection()'));
  if (hexes && hexes.length === 0) { toast.info('No colors found in the selection.'); return null; }
  return hexes;
};

// --- Project embed / sync ---

export const projectPaletteExists = async (): Promise<boolean> => {
  if (!isCEPEnvironment()) return false;
  return (await evalScript('projectPaletteExists()')).trim() === 'true';
};

// Embed the palette into the current project's palette comp. Returns success.
// `quiet` suppresses the success toast (used by auto-sync so it doesn't toast
// on every edit); errors/warnings still surface.
export const syncPaletteToProject = async (hexes: string[], cols = 8, quiet = false): Promise<boolean> => {
  if (!isCEPEnvironment()) { if (!quiet) toast.error('Only works inside After Effects.'); return false; }
  const bare = hexes.map((h) => h.replace(/^#/, '').toUpperCase());
  const result = await evalScript(`syncPaletteToProject(${lit(JSON.stringify(bare))}, ${cols})`);
  if (result.indexOf('Error:') === 0) { toast.error(result.slice(6).trim()); return false; }
  if (result.indexOf('Warning:') === 0) { if (!quiet) toast.info(result.slice(8).trim()); return false; }
  if (!quiet && typeof result === 'string' && result.trim()) toast.success(result.trim());
  return true;
};

// Read the project's embedded palette. quiet=true suppresses the "none yet"
// info toast (for auto-detect on load).
export const getProjectPaletteColors = async (quiet = false): Promise<string[] | null> => {
  if (!isCEPEnvironment()) return null;
  return parseHexArrayResult(await evalScript('getProjectPaletteColors()'), quiet);
};
