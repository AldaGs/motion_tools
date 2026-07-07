// Color sampling with two backends:
//
//  • Inside After Effects (CEP), the browser EyeDropper API doesn't exist —
//    AE's CEF build predates Chromium 95. So we round-trip through AE's own
//    native color picker (which has an on-canvas eyedropper) via a throwaway
//    Color Control effect. See pickColorViaAe in aeColor / hostscript.jsx.
//  • In a plain browser (dev preview), we use the native EyeDropper API when
//    the runtime supports it.
//
// Callers gate their UI on EYEDROPPER_AVAILABLE and pass the current color as a
// seed (used by the AE picker; ignored by the browser API).

import { isCEPEnvironment } from './adobe';
import { pickColorViaAe } from './aeColor';

interface EyeDropperResult { sRGBHex: string }
interface EyeDropperCtor { new (): { open(): Promise<EyeDropperResult> } }

const getCtor = (): EyeDropperCtor | undefined =>
  (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

const BROWSER_SUPPORTED = typeof getCtor() === 'function';

// True whenever *some* backend can pick a color: AE's picker in CEP, or the
// browser API elsewhere.
export const EYEDROPPER_AVAILABLE = isCEPEnvironment() || BROWSER_SUPPORTED;

export const pickScreenColor = async (seedHex = '#808080'): Promise<string | null> => {
  if (isCEPEnvironment()) return pickColorViaAe(seedHex);
  const Ctor = getCtor();
  if (!Ctor) return null;
  try {
    const res = await new Ctor().open();
    return '#' + res.sRGBHex.replace(/^#/, '').toUpperCase();
  } catch {
    return null; // user pressed Escape / dismissed
  }
};
