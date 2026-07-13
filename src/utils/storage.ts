// src/utils/storage.ts

import type { AppData, CustomEase } from '../types';
import { scheduleAutoPush } from '../cloud/autoSync';

declare global {
  interface Window {
    require: any;
    CSInterface: any;
    SystemPath: any;
    __adobe_cep__: any;
  }
}

export const defaultProfile: AppData = {
  activeProfileId: "profile-1",
  settings: {
    buttonSize: 80,        // Minimum width of buttons in px
    bezierButtonSize: 40,  // Mini curve preset size in the easing editor
    spacing: 8,            // Gap between buttons in px
    enableContext: true,   // Toggle the heartbeat
    customEases: [
      { name: 'My Snappy', p1: { x: 0.8, y: 0 }, p2: { x: 0.2, y: 1 } }
    ],
    // The migration code in loadConfig fills these from `customEases` when
    // they're missing — but if loadConfig short-circuits to defaultProfile
    // (no config files present), the easing panel still needs them to
    // render its profile dropdown and ⚙ button. Seed them here so the
    // fallback case isn't visually broken.
    easingProfiles: [
      { id: 'ep_default', name: 'Default', eases: [
        { name: 'My Snappy', p1: { x: 0.8, y: 0 }, p2: { x: 0.2, y: 1 }, source: 'user' as const },
      ] },
    ],
    activeEasingProfileId: 'ep_default',
    easingTopHeight: 240,
    lastOverrideProfileId: null,
    easingClickToApply: false,
    showCurvePreview: false,
    enableCommandPalette: false,
    commandPaletteHotkey: 'Ctrl+Space',
    lockMacros: false,
    undoHistorySize: 10,
  },
  profiles: [
    {
      id: "profile-1",
      name: "Global Tools",
      autoTriggerContext: "none", // Always shows if nothing else matches
      macros: [
        { id: "m1", label: "Add Null", type: "menuCommand", payload: "2767", color: "#3498db" }
      ]
    },
    {
      id: "profile-2",
      name: "Text Tools",
      autoTriggerContext: "textLayer", // ONLY shows when a text layer is selected
      macros: [
        { id: "m2", label: "Center Anchor", type: "menuCommand", payload: "3742", color: "#e67e22" },
        { id: "m3", label: "Convert to Shapes", type: "menuCommand", payload: "3781", color: "#f1c40f" }
      ]
    },
    {
      id: "profile-3",
      name: "Shape Tools",
      autoTriggerContext: "shapeLayer", // ONLY shows when a shape layer is selected
      macros: [
        { id: "m4", label: "Group Shapes", type: "menuCommand", payload: "3741", color: "#9b59b6" }
      ]
    }
  ]
};

// Settings keys belonging to the easing config file. Anything not in this set
// is persisted to the macros file.
const EASING_SETTING_KEYS: ReadonlyArray<keyof AppData['settings']> = [
  'customEases',
  'easingProfiles',
  'activeEasingProfileId',
  'easingSourceFilter',
  'easingTopHeight',
  'bezierButtonSize',
  'easingClickToApply',
  'showCurvePreview',
];

// Some CEP versions return getSystemPath() as a `file://` URL with
// percent-encoded characters; others return a plain Windows/POSIX path.
// Normalize to a plain absolute path so it can be fed to fs.* directly.
const normalizeSystemPath = (raw: string | undefined | null): string => {
  if (!raw) return '';
  let s = String(raw);
  // Strip "file://" or the malformed "file:" with a single backslash that
  // some CEP builds produce.
  s = s.replace(/^file:\/{0,3}/i, '');
  // Decode %20 and friends.
  try { s = decodeURIComponent(s); } catch { /* leave as-is on bad escapes */ }
  // On Windows the URL form is "/C:/Users/..." — drop the leading slash.
  if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  return s;
};

const getConfigDir = (): string | null => {
  if (typeof window.CSInterface === 'undefined') return null;
  const cs = new window.CSInterface();
  const fs = window.require('fs');
  const path = window.require('path');

  const userDataPath = normalizeSystemPath(cs.getSystemPath(window.SystemPath.USER_DATA));
  if (!userDataPath) return null;
  const configDir = path.join(userDataPath, 'AGS-Extensions');

  try {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  } catch (e) {
    console.error('Failed to create config dir', configDir, e);
    return null;
  }

  return configDir;
};

const joinPath = (dir: string, name: string): string => {
  const path = window.require('path');
  return path.join(dir, name);
};

// Backwards-compatible: returns the macros file path. Used by file-watchers.
export const getConfigPath = () => {
  const dir = getConfigDir();
  return dir ? joinPath(dir, 'macros.json') : null;
};

export const getMacrosPath = getConfigPath;

export const getEasingPath = () => {
  const dir = getConfigDir();
  return dir ? joinPath(dir, 'easing.json') : null;
};

const getLegacyPath = () => {
  const dir = getConfigDir();
  return dir ? joinPath(dir, 'config.json') : null;
};

const writeAtomic = (filePath: string, contents: string) => {
  const fs = window.require('fs');
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, contents, 'utf8');
  // Windows: rename-over-existing can transiently fail with EPERM/EBUSY when
  // another panel/file-watcher has the destination briefly open. Retry a few
  // times with a tiny backoff before giving up. We use a busy-wait loop
  // because writeAtomic must stay synchronous (called from beforeunload).
  let lastErr: any = null;
  const deadlines = [0, 8, 24, 60]; // ~92ms total worst case
  for (const wait of deadlines) {
    if (wait > 0) {
      const until = Date.now() + wait;
      while (Date.now() < until) { /* spin */ }
    }
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (err: any) {
      lastErr = err;
      const code = err?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
    }
  }
  // Best-effort cleanup of the .tmp so it doesn't accumulate.
  try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  throw lastErr;
};

const splitSettings = (settings: AppData['settings']) => {
  const easing: any = {};
  const macro: any = {};
  for (const k of Object.keys(settings) as Array<keyof AppData['settings']>) {
    if (EASING_SETTING_KEYS.indexOf(k) >= 0) easing[k] = (settings as any)[k];
    else macro[k] = (settings as any)[k];
  }
  return { easing, macro };
};

// Best-effort schema sanitiser. Returns a value matching the shape of T,
// dropping any sub-entries that fail validation. We don't reject the whole
// config on a single bad macro — a corrupted file should still leave the
// user with a usable panel.

const VALID_MACRO_TYPES = new Set(['menuCommand', 'expression', 'script', 'sequence', 'ffx']);

/** Per-load counters surfaced to the UI so users know when something got
 * silently coerced or dropped. Reset on each `loadConfig` call. */
export interface LoadDiagnostics {
  droppedMacros: number;
  droppedProfiles: number;
  droppedEases: number;
  droppedEasingProfiles: number;
  coercedFields: number;
  errors: string[];
}
let lastDiagnostics: LoadDiagnostics = {
  droppedMacros: 0, droppedProfiles: 0, droppedEases: 0, droppedEasingProfiles: 0, coercedFields: 0, errors: [],
};
export const getLastLoadDiagnostics = (): LoadDiagnostics => lastDiagnostics;
const resetDiag = () => {
  lastDiagnostics = { droppedMacros: 0, droppedProfiles: 0, droppedEases: 0, droppedEasingProfiles: 0, coercedFields: 0, errors: [] };
};

// Loose sanitiser: prefer to coerce a half-broken entry into something usable
// over dropping it. Only entries with no recoverable identity (no id) are
// rejected. This means a user who loses a `payload` field from a custom macro
// gets an empty-payload macro they can fix in-app, instead of the entire
// profile vanishing into defaults.
const sanitizeMacro = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;

  const coerce = <T,>(cond: boolean, fb: T): T => { if (!cond) lastDiagnostics.coercedFields++; return fb; };

  const label = typeof raw.label === 'string' ? raw.label : coerce(false, '');
  const type = (typeof raw.type === 'string' && VALID_MACRO_TYPES.has(raw.type)) ? raw.type : coerce(false, 'menuCommand');
  const payload = typeof raw.payload === 'string' ? raw.payload : coerce(false, '');
  const color = typeof raw.color === 'string' ? raw.color : coerce(false, '#3498db');

  return {
    id: raw.id,
    linkId: typeof raw.linkId === 'string' ? raw.linkId : undefined,
    label, type, payload, color,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    hotkey: typeof raw.hotkey === 'string' ? raw.hotkey : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string') : undefined,
    menuCommandName: typeof raw.menuCommandName === 'string' ? raw.menuCommandName : undefined,
  };
};

const sanitizeProfile = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) { lastDiagnostics.droppedProfiles++; return null; }
  const macros: any[] = [];
  if (Array.isArray(raw.macros)) {
    for (const m of raw.macros) {
      const ok = sanitizeMacro(m);
      if (ok) macros.push(ok); else lastDiagnostics.droppedMacros++;
    }
  }
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : 'Untitled',
    autoTriggerContext: typeof raw.autoTriggerContext === 'string' ? raw.autoTriggerContext : 'none',
    macros,
  };
};

const sanitizeEase = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') { lastDiagnostics.droppedEases++; return null; }
  if (typeof raw.name !== 'string') { lastDiagnostics.droppedEases++; return null; }
  const p1 = raw.p1, p2 = raw.p2;
  if (!p1 || !p2) { lastDiagnostics.droppedEases++; return null; }
  const nums = [p1.x, p1.y, p2.x, p2.y];
  if (!nums.every((n: any) => typeof n === 'number' && isFinite(n))) { lastDiagnostics.droppedEases++; return null; }
  const source = raw.source === 'flow' || raw.source === 'mt' || raw.source === 'user'
    ? raw.source
    : undefined;
  return { name: raw.name, p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, source };
};

const sanitizeEasingProfile = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') { lastDiagnostics.droppedEasingProfiles++; return null; }
  if (typeof raw.id !== 'string' || !raw.id) { lastDiagnostics.droppedEasingProfiles++; return null; }
  const eases = Array.isArray(raw.eases) ? raw.eases.map(sanitizeEase).filter(Boolean) : [];
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : 'Untitled',
    eases,
  };
};

const sanitizeProfiles = (raw: any): any[] | null => {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(sanitizeProfile).filter(Boolean);
  return out.length > 0 ? out : null;
};

export const loadConfig = (): AppData => {
  resetDiag();
  try {
    if (typeof window.require !== 'function') return defaultProfile;
    const fs = window.require('fs');
    const macrosPath = getMacrosPath();
    const easingPath = getEasingPath();
    const legacyPath = getLegacyPath();

    // Migration: legacy config.json present, split files absent.
    if (
      legacyPath && fs.existsSync(legacyPath) &&
      macrosPath && !fs.existsSync(macrosPath)
    ) {
      try {
        const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as AppData;
        if (raw && raw.profiles) {
          saveConfig({
            ...raw,
            settings: { ...defaultProfile.settings, ...(raw.settings || {}) },
          });
        }
      } catch (e: any) {
        console.error("Legacy migration failed", e);
        lastDiagnostics.errors.push(`legacy: ${e?.message ?? String(e)}`);
      }
    }

    // Read each file in its own try-catch so a corrupted easing.json can't
    // erase the macros panel (and vice versa). Also keep a backup of the bad
    // file alongside it so the user can recover by hand.
    const tryReadJson = (path: string | null, label: string): any => {
      if (!path || !fs.existsSync(path)) return null;
      try {
        return JSON.parse(fs.readFileSync(path, 'utf8'));
      } catch (e: any) {
        console.error(`Failed to parse ${label} (${path})`, e);
        lastDiagnostics.errors.push(`${label}: ${e?.message ?? String(e)}`);
        try {
          // Best-effort: stash the corrupt file so the user can inspect it.
          const bak = `${path}.corrupt-${Date.now()}.bak`;
          fs.copyFileSync(path, bak);
          lastDiagnostics.errors.push(`${label} backup: ${bak}`);
        } catch { /* swallow — we still want the panel to load */ }
        return null;
      }
    };

    const macroData: any = tryReadJson(macrosPath, 'macros.json');
    const easingData: any = tryReadJson(easingPath, 'easing.json');

    if (!macroData && !easingData) return defaultProfile;

    const settings: AppData['settings'] = {
      ...defaultProfile.settings,
      ...(macroData?.settings ?? {}),
      ...(easingData?.settings ?? {}),
    };
    if (!Array.isArray(settings.customEases)) settings.customEases = [];

    // --- Easing profiles migration / sanitisation ---
    // Pre-existing installs only have `customEases`. On first read with the
    // new code, wrap it into a "Default" profile and stop using the flat
    // field going forward. We keep `customEases` populated as a one-release
    // safety mirror so older builds don't lose data if a user downgrades.
    let easingProfilesRaw: any = settings.easingProfiles;
    let easingProfiles: any[] | null = Array.isArray(easingProfilesRaw)
      ? easingProfilesRaw.map(sanitizeEasingProfile).filter(Boolean)
      : null;
    if (!easingProfiles || easingProfiles.length === 0) {
      const seed = (settings.customEases ?? []).map(sanitizeEase).filter(Boolean);
      easingProfiles = [{ id: 'ep_default', name: 'Default', eases: seed }];
    }
    settings.easingProfiles = easingProfiles;

    // Validate / repoint the active id.
    if (
      typeof settings.activeEasingProfileId !== 'string' ||
      !easingProfiles.some((p: any) => p.id === settings.activeEasingProfileId)
    ) {
      settings.activeEasingProfileId = easingProfiles[0].id;
    }

    // Mirror the active profile's eases into the legacy `customEases` slot
    // so existing callers (and an older build, briefly, if the user downgrades)
    // keep seeing the active set.
    const active = easingProfiles.find((p: any) => p.id === settings.activeEasingProfileId);
    settings.customEases = active ? active.eases : [];

    // Strip malformed profile/macro entries instead of crashing the panel.
    const sanitizedProfiles = sanitizeProfiles(macroData?.profiles) ?? defaultProfile.profiles;
    const activeProfileId =
      typeof macroData?.activeProfileId === 'string'
      && sanitizedProfiles.some((p: any) => p.id === macroData.activeProfileId)
        ? macroData.activeProfileId
        : sanitizedProfiles[0].id;

    return {
      activeProfileId,
      profiles: sanitizedProfiles,
      settings,
    };
  } catch (err) {
    console.error("Failed to load config, using default.", err);
  }
  return defaultProfile;
};

/** Returns the active easing profile. Falls back to a synthetic empty
 * profile if state is somehow torn — the easing panel should always have
 * something to render. */
export const getActiveEasingProfile = (data: AppData) => {
  const list = data.settings.easingProfiles ?? [];
  const id = data.settings.activeEasingProfileId;
  return list.find((p) => p.id === id) ?? list[0] ?? { id: 'ep_default', name: 'Default', eases: [] };
};

/** Replaces the active profile's `eases` and returns the updated AppData.
 * Also keeps the legacy `customEases` mirror in sync. */
export const setActiveEases = (data: AppData, eases: CustomEase[]): AppData => {
  const list = data.settings.easingProfiles ?? [];
  const id = data.settings.activeEasingProfileId;
  const nextProfiles = list.map((p) => (p.id === id ? { ...p, eases } : p));
  return {
    ...data,
    settings: {
      ...data.settings,
      easingProfiles: nextProfiles,
      customEases: eases, // legacy mirror — see migration note in loadConfig
    },
  };
};

/** Sets the active easing profile id and refreshes the legacy mirror. */
export const setActiveEasingProfileId = (data: AppData, id: string): AppData => {
  const list = data.settings.easingProfiles ?? [];
  if (!list.some((p) => p.id === id)) return data;
  const target = list.find((p) => p.id === id)!;
  return {
    ...data,
    settings: {
      ...data.settings,
      activeEasingProfileId: id,
      customEases: target.eases,
    },
  };
};

export const saveConfig = (data: AppData) => {
  try {
    const macrosPath = getMacrosPath();
    const easingPath = getEasingPath();
    if (!macrosPath || !easingPath) return;

    const { macro, easing } = splitSettings(data.settings);

    const macroFile = {
      activeProfileId: data.activeProfileId,
      profiles: data.profiles,
      settings: macro,
    };
    const easingFile = {
      settings: easing,
    };

    writeAtomic(macrosPath, JSON.stringify(macroFile, null, 2));
    writeAtomic(easingPath, JSON.stringify(easingFile, null, 2));
    // This single call persists both the toolbar (macros) and eases (easing)
    // backup files, so queue a background push for each.
    scheduleAutoPush('toolbar');
    scheduleAutoPush('eases');
  } catch (err) {
    console.error("Failed to save config.", err);
  }
};

export const setDialogPayload = (payload: any) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const payloadPath = path.join(path.dirname(configPath), 'dialogPayload.json');
      fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
    }
  } catch (e) { }
};

// Reads and *consumes* the dialog payload. The file is unlinked after parse so
// a later panel relaunch (without a fresh setDialogPayload call) can't replay
// a stale action. Best-effort cleanup — any IO error is swallowed and we
// return whatever we managed to parse.
export const getDialogPayload = (): any => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return null;
    const payloadPath = path.join(path.dirname(configPath), 'dialogPayload.json');
    if (!fs.existsSync(payloadPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    try { fs.unlinkSync(payloadPath); } catch (_) { /* ignore */ }
    return parsed;
  } catch (e) { }
  return null;
};

// Persist the Motion Color panel's last base color (and view prefs) so a fresh
// panel open restores the previous configuration. Unlike dialogPayload this is
// *not* consumed on read — it survives across opens until overwritten.
export const saveColorState = (state: { hex: string; harmony?: string; showAll?: boolean; showSliders?: boolean; wheelSize?: number }) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const statePath = path.join(path.dirname(configPath), 'colorState.json');
      fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
      scheduleAutoPush('color');
    }
  } catch (e) { }
};

export const loadColorState = (): { hex: string; harmony?: string; showAll?: boolean; showSliders?: boolean; wheelSize?: number } | null => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return null;
    const statePath = path.join(path.dirname(configPath), 'colorState.json');
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed.hex === 'string' ? parsed : null;
  } catch (e) { }
  return null;
};

// Persist the *working* palette (the Color Palette tab's live contents + name)
// so whatever is open auto-restores on the next panel open, even if never
// explicitly "Saved" to the named collection.
export const savePaletteWorkingState = (state: { name: string; colors: string[] }) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const statePath = path.join(path.dirname(configPath), 'paletteState.json');
      fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
      scheduleAutoPush('color');
    }
  } catch (e) { }
};

export const loadPaletteWorkingState = (): { name: string; colors: string[] } | null => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return null;
    const statePath = path.join(path.dirname(configPath), 'paletteState.json');
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const colors = Array.isArray(parsed?.colors) ? parsed.colors.filter((c: unknown) => typeof c === 'string') : [];
    return { name: typeof parsed?.name === 'string' ? parsed.name : 'Untitled', colors };
  } catch (e) { }
  return null;
};

// Motion Color panel preferences (exposed via the header ⚙ menu). Kept in its
// own file so it's independent of the working-palette/wheel state.
export interface ColorSettings { autoUpdateOpen: boolean; autoSyncProject: boolean; dedupAiAfterInsert: boolean }

const COLOR_SETTINGS_DEFAULTS: ColorSettings = { autoUpdateOpen: false, autoSyncProject: false, dedupAiAfterInsert: true };

export const loadColorSettings = (): ColorSettings => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const p = path.join(path.dirname(configPath), 'colorSettings.json');
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { ...COLOR_SETTINGS_DEFAULTS, ...parsed };
      }
    }
  } catch (e) { }
  return { ...COLOR_SETTINGS_DEFAULTS };
};

export const saveColorSettings = (settings: ColorSettings) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const p = path.join(path.dirname(configPath), 'colorSettings.json');
      fs.writeFileSync(p, JSON.stringify(settings), 'utf8');
      scheduleAutoPush('color');
    }
  } catch (e) { }
};

// Motion GIFS panel preferences. Every user-facing option lives here; the main
// panel only shows export buttons + progress, and the floating settings panel
// edits this file. Persisted independently in gifSettings.json.
export interface GifSettings {
  templateIndex: number;
  outputFormat: 'gif' | 'webm' | 'apng';  // final container: GIF (gifski), WebM VP9, or animated PNG
  outputDir: string;
  sizeMode: 'comp' | 'custom';   // 'comp' = keep the comp's width
  width: number;
  fpsMode: 'comp' | 'custom';    // 'comp' = keep the comp's frame rate
  fps: number;
  quality: number;               // gifski 1–100
  loopForever: boolean;
  keepFrames: boolean;
  overwrite: boolean;            // reuse the plain <comp>.ext name; false = append a -NN version suffix
  openFolder: boolean;           // reveal the GIF in Explorer/Finder after export
  playAfter: boolean;            // open the GIF in the default player after export
  renderInBackground: boolean;   // render via aerender so AE stays editable
}

const GIF_SETTINGS_DEFAULTS: GifSettings = {
  templateIndex: 0,
  outputFormat: 'gif',
  outputDir: '',
  sizeMode: 'comp',
  width: 540,
  fpsMode: 'comp',
  fps: 12,
  quality: 70,
  loopForever: true,
  keepFrames: false,
  overwrite: false,
  openFolder: false,
  playAfter: true,
  renderInBackground: false,
};

export const loadGifSettings = (): GifSettings => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const p = path.join(path.dirname(configPath), 'gifSettings.json');
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { ...GIF_SETTINGS_DEFAULTS, ...parsed };
      }
    }
  } catch (e) { }
  return { ...GIF_SETTINGS_DEFAULTS };
};

export const saveGifSettings = (settings: GifSettings) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const p = path.join(path.dirname(configPath), 'gifSettings.json');
      fs.writeFileSync(p, JSON.stringify(settings), 'utf8');
      scheduleAutoPush('gifs');
    }
  } catch (e) { }
};

// ------------- MTAG Switch panel settings ----------------------------------
// Persist the Switch panel's last toggle selection (grouped / center-anchor) so
// a fresh panel open restores the user's previous choice instead of the
// hard-coded defaults. Stored independently in switchSettings.json.
export interface SwitchSettings {
  grouped: boolean;       // import all items into one layer vs. one layer each
  centerAnchor: boolean;  // center the anchor point of the imported layer(s)
  parametric: boolean;    // send recognised primitives as live AE shapes vs. raw paths
}

const SWITCH_SETTINGS_DEFAULTS: SwitchSettings = { grouped: true, centerAnchor: false, parametric: true };

export const loadSwitchSettings = (): SwitchSettings => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const p = path.join(path.dirname(configPath), 'switchSettings.json');
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
          grouped: typeof parsed?.grouped === 'boolean' ? parsed.grouped : SWITCH_SETTINGS_DEFAULTS.grouped,
          centerAnchor: typeof parsed?.centerAnchor === 'boolean' ? parsed.centerAnchor : SWITCH_SETTINGS_DEFAULTS.centerAnchor,
          parametric: typeof parsed?.parametric === 'boolean' ? parsed.parametric : SWITCH_SETTINGS_DEFAULTS.parametric,
        };
      }
    }
  } catch (e) { }
  return { ...SWITCH_SETTINGS_DEFAULTS };
};

export const saveSwitchSettings = (settings: SwitchSettings) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const p = path.join(path.dirname(configPath), 'switchSettings.json');
      fs.writeFileSync(p, JSON.stringify(settings), 'utf8');
      scheduleAutoPush('switch');
    }
  } catch (e) { }
};

// --- Named color palettes -------------------------------------------------
// Each palette is a JSON file { name, colors: string[] } inside a "Palettes"
// folder next to the config, so they're easy to browse/back up on disk.

const getPalettesDir = (): string | null => {
  try {
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return null;
    const dir = path.join(path.dirname(configPath), 'Palettes');
    const fs = window.require('fs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) { return null; }
};

// Filesystem-safe file stem for a palette name.
const paletteFileName = (name: string) => name.replace(/[^\w\- ]+/g, '_').replace(/\s+/g, ' ').trim() || 'palette';

export interface ColorPalette { name: string; colors: string[] }

export const listPalettes = (): string[] => {
  try {
    const fs = window.require('fs');
    const dir = getPalettesDir();
    if (!dir) return [];
    return fs.readdirSync(dir)
      .filter((f: string) => /\.json$/i.test(f))
      .map((f: string) => f.replace(/\.json$/i, ''))
      .sort((a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch (e) { return []; }
};

export const loadPalette = (name: string): ColorPalette | null => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const dir = getPalettesDir();
    if (!dir) return null;
    const file = path.join(dir, paletteFileName(name) + '.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const colors = Array.isArray(parsed?.colors) ? parsed.colors.filter((c: unknown) => typeof c === 'string') : [];
    return { name: typeof parsed?.name === 'string' ? parsed.name : name, colors };
  } catch (e) { return null; }
};

// Returns true on success. Writes/overwrites the palette file.
export const savePalette = (palette: ColorPalette): boolean => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const dir = getPalettesDir();
    if (!dir) return false;
    const file = path.join(dir, paletteFileName(palette.name) + '.json');
    fs.writeFileSync(file, JSON.stringify({ name: palette.name, colors: palette.colors }, null, 2), 'utf8');
    scheduleAutoPush('color');
    return true;
  } catch (e) { return false; }
};

export const deletePalette = (name: string): boolean => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const dir = getPalettesDir();
    if (!dir) return false;
    const file = path.join(dir, paletteFileName(name) + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    scheduleAutoPush('color');
    return true;
  } catch (e) { return false; }
};

// src/utils/storage.ts

export const getFilesInDirectory = (dirPath: string) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');

    // Read the directory contents
    const dirents = fs.readdirSync(dirPath, { withFileTypes: true });

    const items = dirents.map((dirent: any) => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      path: path.join(dirPath, dirent.name).replace(/\\/g, "/")
    }));

    // Filter out hidden files (starting with '.') and keep only folders or .jsx/.jsxbin files
    const filteredItems = items.filter((item: any) => {
      if (item.name.startsWith('.')) return false;
      if (item.isDirectory) return true;
      return item.name.endsWith('.jsx') || item.name.endsWith('.jsxbin');
    });

    // Sort: Folders first, then files alphabetically
    return filteredItems.sort((a: any, b: any) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

  } catch (err) {
    console.error("Error reading directory", err);
    return [];
  }
};

// Helper to get the user's Documents folder as a safe starting point
export const getDefaultStartingPath = () => {
  if (typeof window.CSInterface === 'undefined') return "C:/";
  const cs = new window.CSInterface();
  const raw = cs.getSystemPath(window.SystemPath.MY_DOCUMENTS);
  return normalizeSystemPath(raw).replace(/\\/g, "/");
};

/**
 * Converts an absolute path to a relative one if it's inside the AppData/AG folder.
 * The user specified 'AppData/AG' as the base for relative scripts.
 */
export const relativizePath = (absPath: string): string => {
  if (typeof window.CSInterface === 'undefined') return absPath;
  const cs = new window.CSInterface();
  const path = window.require('path');
  const userData = normalizeSystemPath(cs.getSystemPath(window.SystemPath.USER_DATA));
  const agBase = path.join(userData, 'AGS-Extensions').replace(/\\/g, "/");

  if (absPath.startsWith(agBase)) {
    return "AG://" + absPath.slice(agBase.length + 1);
  }
  return absPath;
};

/**
 * Resolves a potentially relative path back to an absolute one.
 */
export const resolvePath = (relPath: string): string => {
  if (!relPath.startsWith("AG://")) return relPath;
  if (typeof window.CSInterface === 'undefined') return relPath.replace("AG://", "C:/AGS-Extensions/");
  const cs = new window.CSInterface();
  const path = window.require('path');
  const userData = normalizeSystemPath(cs.getSystemPath(window.SystemPath.USER_DATA));
  const agBase = path.join(userData, 'AGS-Extensions').replace(/\\/g, "/");
  return agBase + "/" + relPath.slice(5);
};

// ------------- AI → Color-panel color clip ---------------------------------
// mtagSwitch (Illustrator side) calls saveAiColorClip after extracting colors
// from the selection. MotionColor then calls loadAiColorClip to merge them
// into the active palette. Stored as { colors: string[], ts: number }.

export const saveAiColorClip = (colors: string[]): boolean => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return false;
    const p = path.join(path.dirname(configPath), 'aiColorClip.json');
    fs.writeFileSync(p, JSON.stringify({ colors, ts: Date.now() }), 'utf8');
    return true;
  } catch (e) { return false; }
};

export const loadAiColorClip = (): { colors: string[]; ts: number } | null => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return null;
    const p = path.join(path.dirname(configPath), 'aiColorClip.json');
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed?.colors)) return null;
    return { colors: parsed.colors.filter((c: unknown) => typeof c === 'string'), ts: parsed.ts || 0 };
  } catch (e) { return null; }
};

// Removes the given colors from the clip after they've been inserted into a
// palette, so the same swatches aren't re-added on the next insert. Deletes the
// file once the clip is emptied. Case-insensitive match on hex.
export const removeFromAiColorClip = (colors: string[]): boolean => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return false;
    const p = path.join(path.dirname(configPath), 'aiColorClip.json');
    if (!fs.existsSync(p)) return true;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const remove = new Set(colors.map((c) => c.toUpperCase()));
    const remaining = (Array.isArray(parsed?.colors) ? parsed.colors : [])
      .filter((c: unknown) => typeof c === 'string' && !remove.has((c as string).toUpperCase()));
    if (remaining.length === 0) fs.unlinkSync(p);
    else fs.writeFileSync(p, JSON.stringify({ colors: remaining, ts: parsed.ts || Date.now() }), 'utf8');
    return true;
  } catch (e) { return false; }
};

// ------------- Recent color history ----------------------------------------
// A most-recently-used ring of the last colors added/applied, so the Color
// Palette tab can offer a "history" view. Newest first, deduped (case-
// insensitive), capped at HISTORY_MAX. Stored as a plain string[].

const HISTORY_MAX = 24;

export const loadColorHistory = (): string[] => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return [];
    const p = path.join(path.dirname(configPath), 'colorHistory.json');
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c: unknown) => typeof c === 'string').slice(0, HISTORY_MAX);
  } catch (e) { return []; }
};

const saveColorHistory = (colors: string[]) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return;
    const p = path.join(path.dirname(configPath), 'colorHistory.json');
    fs.writeFileSync(p, JSON.stringify(colors.slice(0, HISTORY_MAX)), 'utf8');
    scheduleAutoPush('color');
  } catch (e) { }
};

// Promotes one or more colors to the front of the history ring and persists.
// Returns the updated list so callers can update their in-memory copy without
// a re-read.
export const pushColorHistory = (colors: string[], prev = loadColorHistory()): string[] => {
  const next = [...prev];
  for (const raw of colors) {
    const h = '#' + raw.replace(/^#/, '').toUpperCase();
    const idx = next.findIndex((c) => c.toUpperCase() === h.toUpperCase());
    if (idx >= 0) next.splice(idx, 1);
    next.unshift(h);
  }
  const capped = next.slice(0, HISTORY_MAX);
  saveColorHistory(capped);
  return capped;
};

export const removeFromColorHistory = (hex: string, prev = loadColorHistory()): string[] => {
  const next = prev.filter((c) => c.toUpperCase() !== hex.toUpperCase());
  saveColorHistory(next);
  return next;
};

export const clearColorHistory = (): string[] => { saveColorHistory([]); return []; };