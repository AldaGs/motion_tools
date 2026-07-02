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

// Returns an array of '#'-prefixed hex strings extracted from the selection,
// or null if nothing was extracted / an error occurred (already toasted).
export const extractColorsFromSelection = async (): Promise<string[] | null> => {
  if (!isCEPEnvironment()) { toast.error('Only works inside After Effects.'); return null; }
  const result = await evalScript('extractColorsFromSelection()');
  if (result.indexOf('Error:') === 0) { toast.error(result.slice(6).trim()); return null; }
  if (result.indexOf('Warning:') === 0) { toast.info(result.slice(8).trim()); return null; }
  try {
    const arr = JSON.parse(result);
    if (!Array.isArray(arr)) return null;
    const hexes = arr.map((h: string) => '#' + String(h).replace(/^#/, ''));
    if (hexes.length === 0) { toast.info('No colors found in the selection.'); return null; }
    return hexes;
  } catch {
    toast.error('Could not read extracted colors.');
    return null;
  }
};
