// Host detection + lazy load of the MTAG Switch ExtendScript companion.
// Returns 'ai' | 'ae' | 'unknown'. In the browser dev context it returns
// 'unknown' so callers can no-op instead of throwing.
import type { PeerKind } from './schema';

export type HostApp = 'ai' | 'ae' | 'ps' | 'unknown';

export function detectHost(): HostApp {
  const w = window as any;
  if (typeof w.CSInterface === 'undefined') return 'unknown';
  try {
    const cs = new w.CSInterface();
    const env = cs.getHostEnvironment();
    const app = (env && env.appName) || '';
    if (app === 'ILST') return 'ai';
    if (app === 'AEFT') return 'ae';
    if (app === 'PHXS') return 'ps';
  } catch { /* noop */ }
  return 'unknown';
}

export function hostToPeerKind(h: HostApp): PeerKind {
  if (h === 'ai') return 'ai';
  if (h === 'ps') return 'ps';
  return 'ae';
}

let loaded = false;
let loadingPromise: Promise<void> | null = null;

// Absolute, forward-slashed path to the companion ExtendScript. Used both for
// the local $.evalFile (loading it into this app) and for the BridgeTalk body
// (telling the *other* app to evalFile the very same file — the extension lives
// in one shared CEP folder, so the path is identical in both apps).
export function getSwitchScriptPath(): string {
  const w = window as any;
  if (typeof w.CSInterface === 'undefined') {
    throw new Error('Not in CEP context');
  }
  const cs = new w.CSInterface();
  const extRoot = cs.getSystemPath('extension');
  return `${extRoot.replace(/\\/g, '/')}/jsx/mtagSwitch.jsx`;
}

// Escape a JS string for embedding as a double-quoted ExtendScript literal
// inside an evalScript body.
export function jsxStr(s: string): string {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function loadSwitchScript(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadingPromise) return loadingPromise;
  const w = window as any;
  if (typeof w.CSInterface === 'undefined') {
    return Promise.reject(new Error('Not in CEP context'));
  }
  loadingPromise = new Promise((resolve, reject) => {
    const cs = new w.CSInterface();
    const script = `$.evalFile(${jsxStr(getSwitchScriptPath())})`;
    cs.evalScript(script, (result: string) => {
      if (typeof result === 'string' && result.toLowerCase().indexOf('error') !== -1) {
        reject(new Error(`evalFile failed: ${result}`));
        return;
      }
      loaded = true;
      resolve();
    });
  });
  return loadingPromise;
}

export function evalJsx<T = unknown>(script: string): Promise<T> {
  const w = window as any;
  if (typeof w.CSInterface === 'undefined') {
    return Promise.reject(new Error('Not in CEP context'));
  }
  return new Promise((resolve, reject) => {
    const cs = new w.CSInterface();
    cs.evalScript(script, (raw: string) => {
      // Our jsx entry points return {ok, data|error} as JSON strings.
      // Anything else (CEP transport error, syntax error) surfaces here.
      if (!raw || raw === 'undefined' || raw === 'EvalScript error.') {
        reject(new Error(raw || 'EvalScript transport failure'));
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ok === false) {
          reject(new Error(parsed.error || 'Host-side error'));
          return;
        }
        resolve(parsed.data as T);
      } catch (e: any) {
        reject(new Error(`Bad JSON from host: ${e.message} — raw: ${raw.slice(0, 200)}`));
      }
    });
  });
}
